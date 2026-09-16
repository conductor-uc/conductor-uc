import { Env, Type, baseEnvSchema, loadConfig } from '@cuc/config';
import { dbEnvSchema } from '@cuc/db';
import { eventsEnvSchema } from '@cuc/events';
import { httpEnvSchema } from '@cuc/http';

/**
 * Everything this service reads from the environment.
 *
 * Validated once at startup; the process refuses to start on anything
 * invalid (09 §1). No `cryptoEnvSchema` and no `storageEnvSchema`: this
 * service holds no tenant secrets and touches no object storage — its only
 * external state is Redis (ownership records, 04 §3) and the ESL sockets
 * themselves.
 */
export const configSchema = Type.Object({
  ...baseEnvSchema.properties,
  ...dbEnvSchema.properties,
  ...eventsEnvSchema.properties,
  ...httpEnvSchema.properties,

  /** `redis://host:port` — the same instance FS's own `mod_redis` rate limiting (S2-05) and api-gateway's rate limiter use, a different logical keyspace within it (`REDIS_KEY_PREFIX`). */
  REDIS_URL: Env.url(),
  /** Every key this service writes is prefixed with this (04 §3: "All keys are prefixed with `cuc:{env}:`"). */
  REDIS_KEY_PREFIX: Env.string({ default: 'cuc:dev:' }),

  /**
   * The FreeSWITCH node pool this instance connects ESL to, as
   * `id:host:port` triples separated by commas, e.g.
   * `freeswitch:freeswitch:8021,freeswitch-2:freeswitch-2:8021`. One node in
   * the dev stack until S2-19 adds a second — a list from the start rather
   * than a single host/port pair, so that task is a compose/env change only.
   */
  FS_NODES: Env.list({ default: ['freeswitch:freeswitch:8021'] }),
  /** `event_socket.conf.xml`'s own `password` param — the same value every configured node shares in this stack (`FS_EVENT_SOCKET_PASSWORD`, telephony/freeswitch/conf/vars.xml). */
  FS_EVENT_SOCKET_PASSWORD: Env.secret(),

  /** Node heartbeat TTL (04 §3.1: "10 s, refreshed every 3 s"). */
  HEARTBEAT_TTL_MS: Env.int({ minimum: 1_000, default: 10_000 }),
  HEARTBEAT_INTERVAL_MS: Env.int({ minimum: 500, default: 3_000 }),
  /** Safety TTL on `call:{callUuid}` hashes (04 §3.2: "6 h safety TTL; deleted on hangup") — a backstop for a hangup event this service never saw, not the normal cleanup path. */
  CALL_SAFETY_TTL_MS: Env.int({ minimum: 60_000, default: 6 * 60 * 60 * 1000 }),

  /** Initial ESL reconnect backoff; doubles up to `ESL_RECONNECT_MAX_DELAY_MS` on repeated failures. */
  ESL_RECONNECT_MIN_DELAY_MS: Env.int({ minimum: 100, default: 500 }),
  ESL_RECONNECT_MAX_DELAY_MS: Env.int({ minimum: 1_000, default: 15_000 }),
});

export type ServiceConfig = ReturnType<typeof loadServiceConfig>;

export function loadServiceConfig(env?: Record<string, string | undefined>) {
  return loadConfig(configSchema, env === undefined ? {} : { env });
}

/** One FreeSWITCH node's ESL address, parsed from one `FS_NODES` entry. */
export interface FsNodeConfig {
  readonly id: string;
  readonly host: string;
  readonly port: number;
}

/** Parses `FS_NODES` entries (`id:host:port`) into structured node configs. Throws on a malformed entry — a startup-time failure, same spirit as `loadConfig`'s own validation. */
export function parseFsNodes(entries: readonly string[]): FsNodeConfig[] {
  return entries.map((entry) => {
    const parts = entry.split(':');
    if (parts.length !== 3) {
      throw new Error(`Invalid FS_NODES entry '${entry}': expected 'id:host:port'.`);
    }
    const [id, host, portString] = parts as [string, string, string];
    const port = Number(portString);
    if (id === '' || host === '' || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(
        `Invalid FS_NODES entry '${entry}': expected 'id:host:port' with a valid port.`,
      );
    }
    return { id, host, port };
  });
}
