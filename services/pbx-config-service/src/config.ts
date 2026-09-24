import { Env, Type, baseEnvSchema, loadConfig } from '@cuc/config';
import { cryptoEnvSchema } from '@cuc/crypto';
import { dbEnvSchema } from '@cuc/db';
import { eventsEnvSchema } from '@cuc/events';
import { httpEnvSchema } from '@cuc/http';
import { storageEnvSchema } from '@cuc/storage';

/**
 * Everything this service reads from the environment.
 *
 * Validated once at startup; the process refuses to start on anything invalid
 * (09 §1). Add service-specific variables here rather than reading process.env
 * anywhere else.
 */
export const configSchema = Type.Object({
  ...baseEnvSchema.properties,
  ...dbEnvSchema.properties,
  ...eventsEnvSchema.properties,
  ...cryptoEnvSchema.properties,
  ...storageEnvSchema.properties,
  ...httpEnvSchema.properties,

  /** Base URL for org-service's internal API, e.g. http://org-service:8080. */
  ORG_SERVICE_URL: Env.url(),
  /** Base URL for trunk-service's internal API, e.g. http://trunk-service:8080 (S2-03). */
  TRUNK_SERVICE_URL: Env.url(),
  /**
   * Shared bearer token org-service's/trunk-service's `/internal/v1` routes
   * expect (07 §1's precedent) — must match those services' own
   * INTERNAL_SERVICE_TOKEN.
   */
  INTERNAL_SERVICE_TOKEN: Env.secret(),

  /** The port the SIP edge accepts registrations on, as phones are told (the console's "connect a phone"). */
  SIP_PUBLIC_PORT: Env.port({ default: 5060 }),
  /** Transports the edge accepts, comma-separated, most preferred first: `udp`, `tcp`, `tls`. */
  SIP_PUBLIC_TRANSPORTS: Env.string({ default: 'udp,tcp' }),
});

export type ServiceConfig = ReturnType<typeof loadServiceConfig>;

export function loadServiceConfig(env?: Record<string, string | undefined>) {
  return loadConfig(configSchema, env === undefined ? {} : { env });
}
