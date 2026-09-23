import { Env, Type, baseEnvSchema, loadConfig } from '@cuc/config';
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
  ...storageEnvSchema.properties,
  ...httpEnvSchema.properties,

  /** org-service, for the `resellerId`-per-tenant lookup (`org-client.ts`). */
  ORG_SERVICE_URL: Env.url(),
  /** Shared bearer token this service's own `/internal/v1` routes would expect — none exist yet, kept for parity with every other service's own config shape. */
  INTERNAL_SERVICE_TOKEN: Env.secret(),
  /**
   * `mod_json_cdr`'s own shared HTTP-Basic-auth token (`routes/ingest.routes.ts`)
   * — the same `FS_XML_CURL_TOKEN`-family convention telephony-config's own
   * config uses, a distinct env var here because this is a different
   * service's own FS-facing gate, not the same literal value.
   */
  FS_CDR_INGEST_TOKEN: Env.secret(),
});

export type ServiceConfig = ReturnType<typeof loadServiceConfig>;

export function loadServiceConfig(env?: Record<string, string | undefined>) {
  return loadConfig(configSchema, env === undefined ? {} : { env });
}
