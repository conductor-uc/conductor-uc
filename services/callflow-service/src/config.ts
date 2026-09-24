import { Env, Type, baseEnvSchema, loadConfig } from '@cuc/config';
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
  // TRUST_INTERNAL_HEADERS and INTERNAL_HEADER_SIGNING_SECRET: the identity
  // headers are trusted only when this service is reachable solely through
  // api-gateway, which authenticates the caller and signs them.
  ...httpEnvSchema.properties,
  /**
   * Shared bearer token this service's own `/internal/v1` routes expect
   * (07 §1's precedent) — must match flow_runner/telephony-config's copy.
   */
  INTERNAL_SERVICE_TOKEN: Env.secret(),
});

export type ServiceConfig = ReturnType<typeof loadServiceConfig>;

export function loadServiceConfig(env?: Record<string, string | undefined>) {
  return loadConfig(configSchema, env === undefined ? {} : { env });
}
