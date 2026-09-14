import { Env, Type, baseEnvSchema, loadConfig } from '@cuc/config';

/**
 * Everything this service reads from the environment.
 *
 * Validated once at startup; the process refuses to start on anything invalid
 * (09 §1). Add service-specific variables here rather than reading process.env
 * anywhere else.
 *
 * Does not use `@cuc/http`'s `httpEnvSchema` (`TRUST_INTERNAL_HEADERS` +
 * `INTERNAL_HEADER_SIGNING_SECRET`): that pair is for a service *verifying*
 * `x-internal-*` headers it did not produce. This service is the one signer —
 * `trustInternalHeaders` for its own inbound context is hardcoded `false` in
 * `app.ts`, never configurable, and the secret below is required rather than
 * optional because without it the gateway cannot do the one thing that makes
 * it a gateway.
 */
export const configSchema = Type.Object({
  ...baseEnvSchema.properties,

  /**
   * Signs the `x-internal-*` headers forwarded to every downstream service
   * (S1-08). Must match each service's own `INTERNAL_HEADER_SIGNING_SECRET`.
   */
  INTERNAL_HEADER_SIGNING_SECRET: Env.secret(),

  /** Base URL for identity-service, e.g. http://identity-service:8080. */
  IDENTITY_SERVICE_URL: Env.url(),
  /** Base URL for org-service, e.g. http://org-service:8080. */
  ORG_SERVICE_URL: Env.url(),

  /**
   * The routing table (06, api-gateway): which downstream service owns which
   * public path prefix. Each entry is `prefix=service`, `service` one of
   * `identity` or `org`. Configurable rather than hardcoded so a later stage
   * can add prefixes (or repoint one) without a code change — same reasoning
   * as `PLATFORM_BASE_DOMAIN` being deployment config, not a constant.
   *
   * Order does not matter: prefixes are matched longest-first regardless of
   * how they are listed here.
   */
  ROUTE_TABLE: Env.list({
    default: [
      '/v1/auth=identity',
      '/v1/orgs=identity',
      '/v1/public=org',
      '/v1/resellers=org',
      '/v1/tenants=org',
    ],
  }),

  /**
   * Path prefixes reachable with no `Authorization` header at all (06: "the
   * unauthenticated public routes"). Every one of these must also be a prefix
   * in `ROUTE_TABLE` — a public prefix that routes nowhere is a
   * misconfiguration, not a route.
   *
   * This is the gateway's own coarse check, separate from each downstream
   * route's `public: true` contract: a request that clears this still has to
   * pass whatever the downstream service itself requires.
   */
  PUBLIC_ROUTE_PREFIXES: Env.list({ default: ['/v1/auth', '/v1/public'] }),

  /** Signing algorithm identity-service's access tokens use (07 §2). */
  ACCESS_TOKEN_ALGORITHM: Env.string({ default: 'EdDSA' }),
  /**
   * How long a fetched JWKS is cached before identity-service is asked again,
   * and the minimum time between two fetches triggered by an unrecognised
   * `kid` (protects identity-service from a thundering herd during key
   * rotation). Both are `jose`'s `createRemoteJWKSet` options.
   */
  JWKS_CACHE_MAX_AGE_MS: Env.int({ minimum: 1_000, default: 600_000 }),
  JWKS_COOLDOWN_MS: Env.int({ minimum: 0, default: 30_000 }),

  /** How long a proxied request waits for the downstream service. */
  PROXY_TIMEOUT_MS: Env.int({ minimum: 100, default: 15_000 }),

  /** `redis://host:port` — backs rate limiting (05 §1). */
  REDIS_URL: Env.url(),

  /** Requests from one IP, in one window, before `429`. Applies to every request. */
  RATE_LIMIT_IP_MAX: Env.int({ minimum: 1, default: 300 }),
  RATE_LIMIT_IP_WINDOW_MS: Env.int({ minimum: 1_000, default: 60_000 }),
  /** Requests from one authenticated actor, in one window, before `429`. */
  RATE_LIMIT_ACTOR_MAX: Env.int({ minimum: 1, default: 600 }),
  RATE_LIMIT_ACTOR_WINDOW_MS: Env.int({ minimum: 1_000, default: 60_000 }),

  /**
   * Hostnames CORS allows credentialed requests from (06: "CORS for the
   * console hostnames"). Each is either a reseller's registered console
   * hostname or the master's own — see `org-service`'s `console_hostnames`.
   * Empty is valid: a deployment with no console traffic yet needs no origin
   * allowed.
   */
  CONSOLE_HOSTNAMES: Env.list({ default: [] }),
});

export type ServiceConfig = ReturnType<typeof loadServiceConfig>;

export function loadServiceConfig(env?: Record<string, string | undefined>) {
  return loadConfig(configSchema, env === undefined ? {} : { env });
}
