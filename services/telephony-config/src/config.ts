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
 * `DB_*` (from `dbEnvSchema`) is this service's own schema — its read model
 * (`src/schema.ts`). `OPENSIPS_DB_*` is a second, separate connection to the
 * `opensips` schema (05 §1.1: "Only telephony-config writes to that
 * schema" — a distinct DB user with grants on `opensips` only, provisioned
 * alongside it in S1-11's `mariadb/init/01-schemas.sh`). The two are never
 * the same pool: no cross-schema transaction is possible across them, which
 * is why the projection write and the read-model write are two separate
 * steps rather than one (`src/consumers/*`).
 */
export const configSchema = Type.Object({
  ...baseEnvSchema.properties,
  ...dbEnvSchema.properties,
  ...eventsEnvSchema.properties,
  ...storageEnvSchema.properties,
  ...httpEnvSchema.properties,

  OPENSIPS_DB_HOST: Env.string({ default: '127.0.0.1', description: 'MariaDB host.' }),
  OPENSIPS_DB_PORT: Env.port({ default: 3306, description: 'MariaDB port.' }),
  OPENSIPS_DB_USER: Env.string({ description: "The 'opensips' schema's own DB user." }),
  OPENSIPS_DB_PASSWORD: Env.secret(),
  OPENSIPS_DB_NAME: Env.string({ default: 'opensips' }),
  OPENSIPS_DB_POOL_SIZE: Env.int({ minimum: 1, maximum: 200, default: 10 }),

  /**
   * OpenSIPs' `mi_http` endpoint, e.g. `http://opensips:8888/mi`
   * (`telephony/opensips/opensips.cfg.template`'s `OPENSIPS_MI_PORT`). Only
   * `domain_reload` is ever called (03 §2) — `auth_db` and `usrloc` query
   * MariaDB live and need no reload for a `subscriber` change to take effect.
   */
  OPENSIPS_MI_URL: Env.url(),

  /**
   * OpenSIPs' SIP listener, e.g. `opensips:5060` (03 §2's `OPENSIPS_SIP_PORT`)
   * — where `/fs/dialplan`'s ext→ext bridge (S1-13/S1-14) sends the call
   * back to for `lookup("location")` to resolve the callee's real contact.
   * Deliberately a static config value, not a FreeSWITCH channel variable
   * like `${network_addr}`: confirmed live that variable reflects the
   * *original caller's* own advertised address, not the proxy hop, so a
   * bridge target built from it dials the caller's own phone instead of
   * OpenSIPs.
   */
  OPENSIPS_SIP_URI: Env.string(),

  /** Base URL for pbx-config-service's internal API, e.g. http://pbx-config-service:8080. */
  PBX_CONFIG_SERVICE_URL: Env.url(),
  /** Base URL for trunk-service's internal API, e.g. http://trunk-service:8080 (S2-02). */
  TRUNK_SERVICE_URL: Env.url(),
  /** Base URL for org-service's internal API, e.g. http://org-service:8080 (S2-04, `org-client.ts`'s country lookup). */
  ORG_SERVICE_URL: Env.url(),
  /**
   * Shared bearer token pbx-config-service's and trunk-service's
   * `/internal/v1` routes expect (07 §1's precedent, same variable name
   * those services use for the identical purpose against org-service) —
   * must match those services' own INTERNAL_SERVICE_TOKEN. Also what this
   * service's own `/internal/v1/tenants/:tenantId/trunks/:id/status`
   * (S2-02) requires from ITS caller (trunk-service's `:status` action) —
   * one shared token for every internal caller in both directions, same as
   * every other pair of services in this repo.
   */
  INTERNAL_SERVICE_TOKEN: Env.secret(),

  /**
   * How often the reconciliation pass runs (06: "every 15 min"). Configurable
   * so a test can drive it without a real 15-minute wait.
   */
  RECONCILE_INTERVAL_MS: Env.int({ minimum: 1000, default: 15 * 60 * 1000 }),

  /**
   * Shared secret FreeSWITCH presents as the password half of HTTP Basic
   * auth (`gateway-credentials value="fs-node:..."`,
   * `telephony/freeswitch/conf/autoload_configs/xml_curl.conf.xml`) on every
   * `/fs/directory`/`/fs/dialplan` request (S1-13). Must match that image's
   * own `FS_XML_CURL_TOKEN` — the same shared-per-environment-token
   * precedent as `INTERNAL_SERVICE_TOKEN` above, not a distinct trust
   * mechanism: this one gates the FS-node-facing surface, that one gates
   * calls this service makes *as a client* to org-service/pbx-config-service.
   */
  FS_XML_CURL_TOKEN: Env.secret(),
});

export type ServiceConfig = ReturnType<typeof loadServiceConfig>;

export function loadServiceConfig(env?: Record<string, string | undefined>) {
  return loadConfig(configSchema, env === undefined ? {} : { env });
}
