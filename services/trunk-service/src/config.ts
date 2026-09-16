import { Env, Type, baseEnvSchema, loadConfig } from '@cuc/config';
import { cryptoEnvSchema } from '@cuc/crypto';
import { dbEnvSchema } from '@cuc/db';
import { eventsEnvSchema } from '@cuc/events';
import { httpEnvSchema } from '@cuc/http';

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
  ...httpEnvSchema.properties,

  /** Base URL for org-service's internal API, e.g. http://org-service:8080. */
  ORG_SERVICE_URL: Env.url(),
  /**
   * Base URL for telephony-config's internal API, e.g.
   * http://telephony-config:8080 — the `:status` action's only source for
   * live registration state (S2-02; `src/telephony-config-client.ts`).
   */
  TELEPHONY_CONFIG_URL: Env.url(),
  /**
   * Shared bearer token org-service's and telephony-config's `/internal/v1`
   * routes expect (07 §1's precedent) — must match those services' own
   * INTERNAL_SERVICE_TOKEN.
   */
  INTERNAL_SERVICE_TOKEN: Env.secret(),
});

export type ServiceConfig = ReturnType<typeof loadServiceConfig>;

export function loadServiceConfig(env?: Record<string, string | undefined>) {
  return loadConfig(configSchema, env === undefined ? {} : { env });
}
