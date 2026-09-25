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
  /** The services behind the tenant routes (G-60). */
  PBX_CONFIG_SERVICE_URL: Env.url(),
  CALLFLOW_SERVICE_URL: Env.url(),
  VOICEMAIL_SERVICE_URL: Env.url(),
  CDR_SERVICE_URL: Env.url(),
  TRUNK_SERVICE_URL: Env.url(),
  RECORDING_SERVICE_URL: Env.url(),

  /**
   * The routing table (06, api-gateway): which downstream service owns which
   * public path. Each entry is `pattern=service`, `service` one of `identity`,
   * `org`, `pbx`, `callflow`, `voicemail`, `cdr`, `trunk` or `recording`. A pattern is a
   * path prefix whose segments are literals or `*` (any one segment), so
   * `/v1/tenants/*` + `/flows` can go to callflow-service while `/v1/tenants`
   * alone still belongs to org-service (G-60). Configurable rather than
   * hardcoded so a later stage can add or repoint a route without a code
   * change.
   *
   * Order does not matter: the most specific pattern wins (more literal
   * segments, then longer), however they are listed here.
   */
  ROUTE_TABLE: Env.list({
    default: [
      '/v1/auth=identity',
      '/v1/orgs=identity',
      '/v1/public=org',
      '/v1/resellers=org',
      // Everything under a tenant that no more specific pattern claims (the
      // tenant itself, its domain, suspend and resume) is org-service's.
      '/v1/tenants=org',
      // The brand the signed-in actor's own org is shown (S3-02).
      '/v1/session=org',
      // The platform's Let's Encrypt settings and its own certificates (G-105).
      '/v1/platform/acme-settings=org',
      '/v1/platform/certificates=org',
      '/v1/platform/network-settings=org',
      // pbx-config-service
      // Desk phones fetching their settings (public; they send Basic credentials).
      '/v1/public/provision=pbx',
      '/v1/tenants/*/devices=pbx',
      '/v1/tenants/*/extensions=pbx',
      '/v1/tenants/*/sip-endpoint=pbx',
      '/v1/tenants/*/dids=pbx',
      '/v1/tenants/*/ring-groups=pbx',
      '/v1/tenants/*/queues=pbx',
      '/v1/tenants/*/agents=pbx',
      '/v1/tenants/*/conference-rooms=pbx',
      '/v1/tenants/*/parking-lots=pbx',
      '/v1/tenants/*/emergency-locations=pbx',
      '/v1/tenants/*/media-assets=pbx',
      '/v1/tenants/*/schedules=pbx',
      // End-user self-service (parity 1e): a person's own extension and call
      // handling. The rest of `/me` is claimed by the services that own it.
      '/v1/tenants/*/me/extension=pbx',
      '/v1/tenants/*/me/directory=pbx',
      '/v1/tenants/*/me/call-handling=pbx',
      // callflow-service
      '/v1/tenants/*/flows=callflow',
      // voicemail-service
      '/v1/tenants/*/voicemail=voicemail',
      '/v1/tenants/*/me/voicemail=voicemail',
      // cdr-service
      '/v1/tenants/*/cdrs=cdr',
      '/v1/tenants/*/cdr-exports=cdr',
      '/v1/tenants/*/billing-records=cdr',
      '/v1/tenants/*/me/calls=cdr',
      // trunk-service
      '/v1/tenants/*/trunks=trunk',
      '/v1/tenants/*/outbound-routes=trunk',
      '/v1/tenants/*/emergency-route=trunk',
      // recording-service (S5-01, S5-04, S5-05)
      '/v1/tenants/*/recordings=recording',
      '/v1/tenants/*/recording-policies=recording',
      '/v1/tenants/*/recording-settings=recording',
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
  /**
   * Serve HTTPS. `TLS_CERT_FILE` and `TLS_KEY_FILE` are the certificate presented
   * when a client names no host, or one there is no certificate for (set both or
   * neither). `TLS_CERT_DIR` holds a certificate per hostname, chosen by the name
   * the client asks for: see `tls.ts`. With none of the three the gateway speaks
   * plain HTTP, for development and behind a proxy that terminates TLS.
   */
  TLS_CERT_FILE: Env.optional(Env.string()),
  TLS_KEY_FILE: Env.optional(Env.string()),
  TLS_CERT_DIR: Env.optional(Env.string()),
  /**
   * Take console hostnames' certificates from org-service, which issues and renews
   * them (G-105), needing `INTERNAL_SERVICE_TOKEN`. Files, if also set, win.
   */
  TLS_FROM_ORG_SERVICE: Env.bool({ default: false }),
  /**
   * The token org-service's internal routes expect. The gateway uses it only to
   * ask for the answer to a certificate authority's HTTP challenge (G-105); left
   * unset, challenges are never answered and no certificate can be requested.
   */
  INTERNAL_SERVICE_TOKEN: Env.optional(Env.secret()),
  /**
   * When set, a plain-HTTP listener on this port redirects browsers to HTTPS, and
   * answers certificate authorities' HTTP challenges. Port 80 in production.
   */
  HTTP_REDIRECT_PORT: Env.optional(Env.port()),
  /** How long browsers are told to insist on HTTPS. 0 leaves the header off. */
  HSTS_MAX_AGE_SECONDS: Env.int({ minimum: 0, default: 31_536_000 }),
  /**
   * Refuse to serve phone provisioning over plain HTTP: the settings hold the
   * extension's SIP password. Development over http://localhost turns it off.
   */
  REQUIRE_HTTPS_FOR_PROVISIONING: Env.bool({ default: true }),
  /**
   * The built console (`flutter build web --no-web-resources-cdn`). When set the
   * gateway serves it from its own origin, with a strict Content-Security-Policy.
   * Unset, something else serves the console (development uses `tests/e2e`).
   */
  CONSOLE_DIR: Env.optional(Env.string()),
  /** Other origins the console may call: the object store it uploads media to. */
  CONSOLE_CONNECT_SOURCES: Env.list({ default: [] }),
  CONSOLE_HOSTNAMES: Env.list({ default: [] }),
});

export type ServiceConfig = ReturnType<typeof loadServiceConfig>;

export function loadServiceConfig(env?: Record<string, string | undefined>) {
  return loadConfig(configSchema, env === undefined ? {} : { env });
}
