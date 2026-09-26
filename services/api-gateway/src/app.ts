import { createServer } from '@cuc/http';
import { createRemotePermissionResolver } from '@cuc/http';
import type { CreateServerOptions, PermissionResolver, Server } from '@cuc/http';
import type { Redis } from 'ioredis';

import { createAccessTokenVerifier } from './auth/access-token-verifier.js';
import { registerAuthentication } from './auth/authenticate.js';
import { createChallengeLookup, registerAcmeChallengeRoute } from './acme-challenge.js';
import { registerConsoleHosting } from './console-hosting.js';
import { registerCors } from './cors.js';
import { registerPlatformHealth } from './platform-health.js';
import { registerProvisioningTransport } from './provisioning-transport.js';
import { registerSecurityHeaders } from './security-headers.js';
import { createOrgCertificateSource } from './certificate-source.js';
import { tlsServerOptions } from './tls.js';
import { createRateLimiter } from './rate-limit/limiter.js';
import { registerRateLimit } from './rate-limit/hooks.js';
import { registerProxy } from './routing/proxy.js';
import { createRealtimeHub, type RealtimeHub } from './realtime/hub.js';
import { createTopicAuthorizer } from './realtime/authorize.js';
import { REALTIME_PATH, registerRealtimeRoute } from './realtime/route.js';
import {
  createLineageLookup,
  createLiveCallsSource,
  createUserExtensionSource,
} from './realtime/sources.js';
import { buildRouteTable } from './routing/route-table.js';
import type { ServiceConfig } from './config.js';

export interface BuildAppOptions {
  readonly config: ServiceConfig;
  readonly redis: Redis;
  /** Overridable in tests so the gateway can verify against a fake identity-service. */
  readonly jwksUrl?: string | URL;
  readonly logger?: CreateServerOptions['logger'];
  /**
   * Namespaces every rate-limit counter this app instance writes. Production
   * has one gateway sharing one Redis, so this is never set there; a test
   * that wants an isolated counter budget (most rate-limit tests do, since
   * `TEST_REDIS_URL` points at one shared server) sets it per app instance.
   */
  readonly rateLimitKeyPrefix?: string;
  /**
   * The realtime hub's inputs, when `REALTIME_ENABLED`. The hub is built here;
   * `onHub` hands it back so the caller can attach the NATS bus once connected
   * (`main.ts` connects in the background, so NATS being down never stops the
   * gateway from serving the API). Tests swap in a fake permission resolver.
   */
  readonly realtime?: {
    readonly permissions?: PermissionResolver;
    readonly onHub?: (hub: RealtimeHub) => void;
  };
}

/**
 * Assembles the gateway's Fastify instance from config and its two live
 * dependencies (Redis, and identity-service's JWKS over HTTP). Split out from
 * `main.ts` so a test can build the same app against fakes without importing
 * process-level bootstrap concerns (listen, signal handlers).
 */
export async function buildApp(options: BuildAppOptions): Promise<Server> {
  const { config } = options;
  const https = tlsServerOptions({
    certFile: config.TLS_CERT_FILE,
    keyFile: config.TLS_KEY_FILE,
    certDir: config.TLS_CERT_DIR,
    source: config.TLS_FROM_ORG_SERVICE
      ? createOrgCertificateSource({
          orgServiceUrl: config.ORG_SERVICE_URL,
          internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
        })
      : undefined,
  });

  const app = await createServer({
    serviceName: config.SERVICE_NAME,
    serviceVersion: config.SERVICE_VERSION,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    logLevel: config.LOG_LEVEL,
    // The gateway is the edge. Facing the internet directly (TRUSTED_PROXIES
    // empty), anyone could send X-Forwarded-For, so the client address (rate
    // limiting, audit) is the socket's own; behind a load balancer, only the
    // listed proxies' forwarded headers are believed (G-113).
    trustProxy: config.TRUSTED_PROXIES.length === 0 ? false : config.TRUSTED_PROXIES,
    // HTTPS when a certificate is configured (TLS_CERT_FILE / TLS_CERT_DIR).
    ...(https === undefined ? {} : { https }),
    // Always false: an external client's own x-internal-* headers must never
    // be believed here — this service is the one that *produces* them, from a
    // verified JWT, not a consumer of them.
    context: { trustInternalHeaders: false },
  });

  // Behind a TLS-terminating proxy the connection here is plain, but the browser
  // is on HTTPS, so HSTS follows what the proxy says (request.protocol), not
  // only whether this process holds a certificate.
  registerSecurityHeaders(app, { hstsMaxAgeSeconds: config.HSTS_MAX_AGE_SECONDS });
  registerProvisioningTransport(app, {
    requireHttps: config.REQUIRE_HTTPS_FOR_PROVISIONING,
  });

  app.addReadinessCheck('redis', async () => {
    const pong = await options.redis.ping();
    return { status: pong === 'PONG' ? 'pass' : 'fail' };
  });

  registerCors(app, config.CONSOLE_HOSTNAMES);

  const verifier = createAccessTokenVerifier({
    jwksUrl: options.jwksUrl ?? new URL('/.well-known/jwks.json', config.IDENTITY_SERVICE_URL),
    algorithm: config.ACCESS_TOKEN_ALGORITHM,
    cacheMaxAgeMs: config.JWKS_CACHE_MAX_AGE_MS,
    cooldownMs: config.JWKS_COOLDOWN_MS,
  });

  registerAuthentication(app, {
    verifier,
    publicPrefixes: config.PUBLIC_ROUTE_PREFIXES,
    selfAuthenticatingPaths: config.REALTIME_ENABLED ? [REALTIME_PATH] : [],
  });

  const rateLimitKeyPrefix = options.rateLimitKeyPrefix ?? '';
  registerRateLimit(app, {
    ipLimiter: createRateLimiter({
      redis: options.redis,
      keyPrefix: `${rateLimitKeyPrefix}rl:ip:`,
      max: config.RATE_LIMIT_IP_MAX,
      windowMs: config.RATE_LIMIT_IP_WINDOW_MS,
    }),
    actorLimiter: createRateLimiter({
      redis: options.redis,
      keyPrefix: `${rateLimitKeyPrefix}rl:actor:`,
      max: config.RATE_LIMIT_ACTOR_MAX,
      windowMs: config.RATE_LIMIT_ACTOR_WINDOW_MS,
    }),
  });

  const table = buildRouteTable(config.ROUTE_TABLE, {
    identity: config.IDENTITY_SERVICE_URL,
    org: config.ORG_SERVICE_URL,
    pbx: config.PBX_CONFIG_SERVICE_URL,
    callflow: config.CALLFLOW_SERVICE_URL,
    voicemail: config.VOICEMAIL_SERVICE_URL,
    cdr: config.CDR_SERVICE_URL,
    trunk: config.TRUNK_SERVICE_URL,
    recording: config.RECORDING_SERVICE_URL,
    call: config.CALL_CONTROL_URL,
  });

  // Served here rather than proxied: it asks every service, so no one service
  // owns it. Registered before the proxy's `/v1/*`, and a specific route wins.
  registerPlatformHealth(app, {
    timeoutMs: 2_000,
    targets: [
      { name: 'identity-service', url: config.IDENTITY_SERVICE_URL },
      { name: 'org-service', url: config.ORG_SERVICE_URL },
      { name: 'pbx-config-service', url: config.PBX_CONFIG_SERVICE_URL },
      { name: 'callflow-service', url: config.CALLFLOW_SERVICE_URL },
      { name: 'voicemail-service', url: config.VOICEMAIL_SERVICE_URL },
      { name: 'cdr-service', url: config.CDR_SERVICE_URL },
      { name: 'trunk-service', url: config.TRUNK_SERVICE_URL },
      { name: 'recording-service', url: config.RECORDING_SERVICE_URL },
      { name: 'call-control', url: config.CALL_CONTROL_URL },
    ],
  });

  // The realtime hub (S5-08). Registered before the proxy's `/v1/*`, though the
  // more specific route would win either way.
  if (config.REALTIME_ENABLED) {
    const internalServiceToken = config.INTERNAL_SERVICE_TOKEN;
    const callControlUrl = config.CALL_CONTROL_URL;
    if (internalServiceToken === undefined) {
      throw new Error(
        'REALTIME_ENABLED needs INTERNAL_SERVICE_TOKEN (or set REALTIME_ENABLED=false).',
      );
    }
    const hub = createRealtimeHub({
      verifier,
      authorizer: createTopicAuthorizer({
        permissions:
          options.realtime?.permissions ??
          createRemotePermissionResolver({
            baseUrl: config.IDENTITY_SERVICE_URL,
            internalServiceToken,
            ttlMs: config.REALTIME_PERMISSION_CACHE_TTL_MS,
          }),
        lineage: createLineageLookup({ baseUrl: config.ORG_SERVICE_URL, internalServiceToken }),
      }),
      liveCalls: createLiveCallsSource({ baseUrl: callControlUrl, internalServiceToken }),
      // S5-15: a person's own extension, for their own calls' topic.
      userExtensions: createUserExtensionSource({
        baseUrl: config.PBX_CONFIG_SERVICE_URL,
        internalServiceToken,
      }),
      logger: app.log,
      limits: {
        authTimeoutMs: config.REALTIME_AUTH_TIMEOUT_MS,
        maxConnectionsPerIp: config.REALTIME_MAX_CONNECTIONS_PER_IP,
        maxConnectionsPerUser: config.REALTIME_MAX_CONNECTIONS_PER_USER,
        maxSubscriptions: config.REALTIME_MAX_SUBSCRIPTIONS,
        maxMessagesPerMinute: config.REALTIME_MAX_MESSAGES_PER_MINUTE,
        maxBufferedBytes: config.REALTIME_MAX_BUFFERED_BYTES,
        heartbeatIntervalMs: config.REALTIME_HEARTBEAT_INTERVAL_MS,
        permissionRecheckMs: config.REALTIME_PERMISSION_RECHECK_MS,
      },
    });
    await registerRealtimeRoute(app, {
      hub,
      allowedHostnames: config.CONSOLE_HOSTNAMES,
      maxMessageBytes: config.REALTIME_MAX_MESSAGE_BYTES,
    });
    options.realtime?.onHub?.(hub);
  }

  registerProxy(app, {
    table,
    timeoutMs: config.PROXY_TIMEOUT_MS,
    internalHeaderSigningSecret: config.INTERNAL_HEADER_SIGNING_SECRET,
  });

  // A certificate authority checking that this host answers for a name it asked for a
  // certificate for (G-105): the answer is held by org-service.
  registerAcmeChallengeRoute(
    app,
    createChallengeLookup({
      orgServiceUrl: config.ORG_SERVICE_URL,
      internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
    }),
  );

  // Last, so every more specific route (the API, health, the platform page) wins.
  if (config.CONSOLE_DIR !== undefined) {
    registerConsoleHosting(app, {
      dir: config.CONSOLE_DIR,
      extraConnectSources: config.CONSOLE_CONNECT_SOURCES,
      realtime: config.REALTIME_ENABLED,
    });
  }

  return app;
}
