import { Env, Type, baseEnvSchema, loadConfig } from '@cuc/config';
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
 *
 * No `cryptoEnvSchema`: this service holds no secrets of its own — not even
 * the tenant's raw upload persists here, only in flight in memory while
 * `ffmpeg` runs (S2-07's own isolation scope).
 */
export const configSchema = Type.Object({
  ...baseEnvSchema.properties,
  ...dbEnvSchema.properties,
  ...eventsEnvSchema.properties,
  ...storageEnvSchema.properties,
  ...httpEnvSchema.properties,

  /** Base URL for pbx-config-service's internal API, e.g. http://pbx-config-service:8080. */
  PBX_CONFIG_SERVICE_URL: Env.url(),
  /**
   * Shared bearer token pbx-config-service's `/internal/v1` routes expect
   * (07 §1's precedent) — must match that service's own
   * INTERNAL_SERVICE_TOKEN.
   */
  INTERNAL_SERVICE_TOKEN: Env.secret(),
  /** Absolute path to the `ffmpeg` binary — `ffmpeg` on $PATH by default (the Dockerfile's own apt install), overridable for a dev machine with a nonstandard install. */
  FFMPEG_PATH: Env.string({ default: 'ffmpeg' }),
  /** Same as `FFMPEG_PATH`, for `ffprobe` — bundled with the same `ffmpeg` apt package, used only to read the input's duration. */
  FFPROBE_PATH: Env.string({ default: 'ffprobe' }),
});

export type ServiceConfig = ReturnType<typeof loadServiceConfig>;

export function loadServiceConfig(env?: Record<string, string | undefined>) {
  return loadConfig(configSchema, env === undefined ? {} : { env });
}
