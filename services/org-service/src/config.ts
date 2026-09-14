import { Env, Type, baseEnvSchema, loadConfig } from '@cuc/config';
import { dbEnvSchema } from '@cuc/db';
import { eventsEnvSchema } from '@cuc/events';

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
  /**
   * Only trust the x-internal-* identity headers when this service is reachable
   * solely through api-gateway, which authenticates the caller and signs them.
   */
  TRUST_INTERNAL_HEADERS: Env.bool({ default: false }),

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
   * Shared bearer token identity-service's `/internal/v1` routes expect
   * (07 §1's precedent) — must match that service's own INTERNAL_SERVICE_TOKEN.
   */
  INTERNAL_SERVICE_TOKEN: Env.secret(),
});

export type ServiceConfig = ReturnType<typeof loadServiceConfig>;

export function loadServiceConfig(env?: Record<string, string | undefined>) {
  return loadConfig(configSchema, env === undefined ? {} : { env });
}
