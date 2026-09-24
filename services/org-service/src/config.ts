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
  ...cryptoEnvSchema.properties,
  ...eventsEnvSchema.properties,
  ...storageEnvSchema.properties,
  ...httpEnvSchema.properties,

  /** Base URL for identity-service's internal API, e.g. http://identity-service:8080. */
  IDENTITY_SERVICE_URL: Env.url(),

  /**
   * Deployment-wide fallback base for a tenant's primary domain when its
   * reseller has no active base domain of its own (02 §3). Never a default
   * that carries a product or codebase name (rule 1) — every deployment must
   * set its own.
   */
  PLATFORM_BASE_DOMAIN: Env.string(),
  /**
   * Overrides the ACME server the certificate worker talks to, for a deployment
   * that runs its own (and for tests against Pebble). Leave unset in production:
   * the operator chooses Let's Encrypt production or staging in the console.
   */
  ACME_DIRECTORY_URL: Env.optional(Env.url()),
  /**
   * Shared bearer token identity-service's `/internal/v1` routes expect
   * (07 §1's precedent) — must match that service's own INTERNAL_SERVICE_TOKEN.
   */
  INTERNAL_SERVICE_TOKEN: Env.secret(),
});

export type ServiceConfig = ReturnType<typeof loadServiceConfig>;

export function loadServiceConfig(env?: Record<string, string | undefined>) {
  return loadConfig(configSchema, env === undefined ? {} : { env });
}
