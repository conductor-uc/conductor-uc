import { Env, Type, baseEnvSchema, loadConfig } from '@cuc/config';
import { dbEnvSchema } from '@cuc/db';
import { eventsEnvSchema } from '@cuc/events';
import { httpEnvSchema } from '@cuc/http';
import { storageEnvSchema } from '@cuc/storage';

/**
 * Everything this service reads from the environment. Validated once at
 * startup; the process refuses to start on anything invalid (09 §1).
 *
 * The node uploader (`src/uploader/main.ts`) is a second process built from the
 * same package and has its own, much smaller schema (`uploader/config.ts`): it
 * never receives database or storage credentials.
 */
export const configSchema = Type.Object({
  ...baseEnvSchema.properties,
  ...dbEnvSchema.properties,
  ...eventsEnvSchema.properties,
  ...storageEnvSchema.properties,
  ...httpEnvSchema.properties,

  /** Shared bearer token this service's `/internal/v1` routes expect (07 §1's precedent). Also what it presents to identity-service. */
  INTERNAL_SERVICE_TOKEN: Env.secret(),

  /**
   * identity-service, e.g. http://identity-service:8080. Asked which roles and grants a
   * signed-in user holds, because no other layer evaluates them per request (G-91) and
   * recordings are the first data where a scoped grant (`recording.listen` on `queue:Q1`)
   * has to be honoured.
   */
  IDENTITY_SERVICE_URL: Env.url(),
  /** How long one user's roles and grants are reused. Kept short: a revoked grant works for at most this long. */
  ACCESS_CACHE_TTL_MS: Env.int({ minimum: 0, default: 5_000 }),

  /**
   * Retention applied to a tenant that has not chosen its own (05 §4). 0 keeps recordings
   * until someone deletes them.
   */
  RECORDING_DEFAULT_RETENTION_DAYS: Env.int({ minimum: 0, maximum: 3650, default: 90 }),
  /** How often the retention sweep runs. */
  RETENTION_SWEEP_INTERVAL_MS: Env.int({ minimum: 1_000, default: 60 * 60 * 1000 }),
  /** Most recordings one sweep expires; the next sweep continues. */
  RETENTION_SWEEP_BATCH: Env.int({ minimum: 1, maximum: 5_000, default: 200 }),
  /**
   * A recording that was registered at call setup but never uploaded (the call had no
   * media, or the node died first, O-13) is marked failed after this long.
   */
  PENDING_RECORDING_MAX_AGE_HOURS: Env.int({ minimum: 1, default: 72 }),
});

export type ServiceConfig = ReturnType<typeof loadServiceConfig>;

export function loadServiceConfig(env?: Record<string, string | undefined>) {
  return loadConfig(configSchema, env === undefined ? {} : { env });
}
