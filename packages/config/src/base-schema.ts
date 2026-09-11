import { Type } from 'typebox';

import { Env } from './env.js';

/**
 * Configuration every service shares. Extend it rather than redeclaring these:
 *
 * ```ts
 * const schema = Type.Object({
 *   ...baseEnvSchema.properties,
 *   DB_URL: Env.secret(),
 * });
 * ```
 *
 * `SERVICE_NAME` has no default on purpose: it names the service in logs,
 * traces, and metrics, and a service that does not set it should not start.
 */
export const baseEnvSchema = Type.Object({
  NODE_ENV: Env.enum(['development', 'test', 'production'], {
    default: 'development',
    description: 'Runtime mode. Production disables developer-only affordances.',
  }),
  SERVICE_NAME: Env.string({
    description: 'Service identity in logs, traces, and metrics, e.g. org-service.',
  }),
  SERVICE_VERSION: Env.string({
    default: '0.0.0',
    description: 'Build version, surfaced on /healthz and in traces.',
  }),
  LOG_LEVEL: Env.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'], {
    default: 'info',
    description: 'Minimum level pino emits.',
  }),
  HTTP_HOST: Env.string({
    default: '0.0.0.0',
    description: 'Bind address for the HTTP listener.',
  }),
  HTTP_PORT: Env.port({
    default: 8080,
    description: 'Bind port for the HTTP listener.',
  }),
  SHUTDOWN_GRACE_MS: Env.int({
    minimum: 0,
    default: 10_000,
    description: 'How long in-flight requests get to finish after SIGTERM.',
  }),
  OTEL_EXPORTER_OTLP_ENDPOINT: Env.optional(
    Env.url({ description: 'OTLP collector endpoint. Tracing is disabled when unset.' }),
  ),
});
