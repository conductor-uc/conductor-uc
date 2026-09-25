import { Env, Type, baseEnvSchema, loadConfig } from '@cuc/config';
import { cryptoEnvSchema } from '@cuc/crypto';
import { dbEnvSchema } from '@cuc/db';
import { eventsEnvSchema } from '@cuc/events';
import { httpEnvSchema } from '@cuc/http';
import { storageEnvSchema } from '@cuc/storage';

/**
 * Everything this service reads from the environment. Validated once at
 * startup; the process refuses to start on anything invalid (09 §1).
 */
export const configSchema = Type.Object({
  ...baseEnvSchema.properties,
  ...dbEnvSchema.properties,
  ...eventsEnvSchema.properties,
  ...cryptoEnvSchema.properties,
  ...storageEnvSchema.properties,
  ...httpEnvSchema.properties,

  /** pbx-config-service, asked which extension belongs to a signed-in person (self-service). */
  PBX_CONFIG_SERVICE_URL: Env.url(),
  /**
   * identity-service, asked what a signed-in person may do
   * (`@cuc/http`'s permission guard). Required, not optional: without it the
   * service would let any signed-in person call any route.
   */
  IDENTITY_SERVICE_URL: Env.url(),
  /** Shared bearer token this service's own `/internal/v1` routes expect (07 §1's precedent). */
  INTERNAL_SERVICE_TOKEN: Env.secret(),

  /**
   * A message whose row was created but whose audio the node uploader never delivered (the
   * caller hung up before anything was recorded, or the node died first) is marked failed
   * after this long (S5-16; recording-service's PENDING_RECORDING_MAX_AGE_HOURS).
   */
  PENDING_MESSAGE_MAX_AGE_HOURS: Env.int({ minimum: 1, default: 72 }),
  /** How often that sweep runs. */
  PENDING_SWEEP_INTERVAL_MS: Env.int({ minimum: 1_000, default: 60 * 60 * 1000 }),
});

export type ServiceConfig = ReturnType<typeof loadServiceConfig>;

export function loadServiceConfig(env?: Record<string, string | undefined>) {
  return loadConfig(configSchema, env === undefined ? {} : { env });
}
