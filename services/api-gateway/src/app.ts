import { createServer } from '@cuc/http';
import type { CreateServerOptions, Server } from '@cuc/http';
import type { Redis } from 'ioredis';

import { createAccessTokenVerifier } from './auth/access-token-verifier.js';
import { registerAuthentication } from './auth/authenticate.js';
import { registerCors } from './cors.js';
import { createRateLimiter } from './rate-limit/limiter.js';
import { registerRateLimit } from './rate-limit/hooks.js';
import { registerProxy } from './routing/proxy.js';
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
}

/**
 * Assembles the gateway's Fastify instance from config and its two live
 * dependencies (Redis, and identity-service's JWKS over HTTP). Split out from
 * `main.ts` so a test can build the same app against fakes without importing
 * process-level bootstrap concerns (listen, signal handlers).
 */
export async function buildApp(options: BuildAppOptions): Promise<Server> {
  const { config } = options;

  const app = await createServer({
    serviceName: config.SERVICE_NAME,
    serviceVersion: config.SERVICE_VERSION,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    logLevel: config.LOG_LEVEL,
    // The gateway is the edge itself, reached through a load balancer — client
    // IPs (rate limiting, audit) come from X-Forwarded-For, not the socket.
    trustProxy: true,
    // Always false: an external client's own x-internal-* headers must never
    // be believed here — this service is the one that *produces* them, from a
    // verified JWT, not a consumer of them.
    context: { trustInternalHeaders: false },
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
  });

  registerProxy(app, {
    table,
    timeoutMs: config.PROXY_TIMEOUT_MS,
    internalHeaderSigningSecret: config.INTERNAL_HEADER_SIGNING_SECRET,
  });

  return app;
}
