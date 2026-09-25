import { Env, Type, loadConfig } from '@cuc/config';

/**
 * The node uploader's environment. Deliberately small: no database, no storage credentials,
 * no event bus. It needs to reach recording-service and voicemail-service, and read and delete
 * files in the spool.
 */
export const uploaderConfigSchema = Type.Object({
  NODE_ENV: Env.enum(['development', 'test', 'production'], { default: 'development' }),
  SERVICE_NAME: Env.string({ default: 'recording-uploader' }),
  SERVICE_VERSION: Env.string({ default: '0.0.0' }),
  LOG_LEVEL: Env.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'], { default: 'info' }),

  /** recording-service, e.g. http://recording-service:8080. */
  RECORDING_SERVICE_URL: Env.url(),
  /**
   * voicemail-service, e.g. http://voicemail-service:8080 (S5-16): where `vm-<id>.wav` files
   * (voicemail messages) go. Required, not optional: every node records voicemail, and an
   * uploader without it would leave every message's audio on the node.
   */
  VOICEMAIL_SERVICE_URL: Env.url(),
  /** The bearer token both services' internal routes expect. */
  INTERNAL_SERVICE_TOKEN: Env.secret(),

  /** Where FreeSWITCH writes recordings; the same path telephony-config's RECORDING_SPOOL_DIR names. */
  SPOOL_DIR: Env.string({ default: '/var/spool/cuc/rec' }),
  SCAN_INTERVAL_MS: Env.int({ minimum: 100, default: 5_000 }),
  /** A file untouched this long, with a closed header, is ready to upload. */
  SETTLE_SECONDS: Env.int({ minimum: 0, default: 30 }),
  /** A file untouched this long is uploaded even if it never closed (the node crashed mid-call). */
  ABANDONED_AFTER_SECONDS: Env.int({ minimum: 1, default: 600 }),
  /** A file on the node this long raises the stuck alert (03 §6: "older than N hours"). */
  STUCK_AFTER_SECONDS: Env.int({ minimum: 1, default: 3_600 }),
  BACKOFF_BASE_MS: Env.int({ minimum: 100, default: 2_000 }),
  BACKOFF_MAX_MS: Env.int({ minimum: 1_000, default: 300_000 }),
  CONCURRENCY: Env.int({ minimum: 1, maximum: 16, default: 2 }),
  /** Serves `/metrics` (Prometheus text) and `/healthz`. */
  METRICS_PORT: Env.port({ default: 9464 }),
  METRICS_HOST: Env.string({ default: '0.0.0.0' }),
  SHUTDOWN_GRACE_MS: Env.int({ minimum: 0, default: 10_000 }),
});

export function loadUploaderConfig(env?: Record<string, string | undefined>) {
  return loadConfig(uploaderConfigSchema, env === undefined ? {} : { env });
}
