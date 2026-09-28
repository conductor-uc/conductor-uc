import { parseRecordingControls, type RecordingControls } from '@cuc/api-contracts';
import type { Redis } from 'ioredis';

import type { NodeStats } from '../normalize.js';

/**
 * The Redis call/node registry (04 §3.1, §3.2) — the one piece of durable-ish
 * state this service owns. Every key is prefixed with `options.keyPrefix`
 * (04 §3: "All keys are prefixed with `cuc:{env}:`"; `config.ts`'s
 * `REDIS_KEY_PREFIX`).
 */
export interface CallRegistry {
  /**
   * Writes/refreshes `fsnode:{id}` (04 §3.1) and adds it to the `fsnodes` set. The status is
   * `draining` while the node is in `fsnodes:draining` (S4-02), otherwise `up`.
   */
  heartbeat(nodeId: string, ttlMs: number, stats?: NodeStats): Promise<void>;
  /**
   * S4-02 (G-123): takes a node out of service for new calls and leases, or puts it back. Kept in
   * the `fsnodes:draining` set with no TTL, so a drain outlives the node's heartbeat key (a node
   * restarted for its upgrade comes back still draining) and this process; `fsnode:{id}`'s status
   * follows at once when the node is up.
   */
  setDraining(nodeId: string, draining: boolean): Promise<void>;
  /** S4-02: how each of these nodes stands, for the operator's node list. */
  nodeStates(nodeIds: readonly string[]): Promise<NodeState[]>;
  /** `call:{callUuid}` on CHANNEL_CREATE, plus its node/tenant index entries. */
  createCall(call: CallRecord, safetyTtlMs: number): Promise<void>;
  /**
   * Merges fields into an existing `call:{callUuid}` hash (e.g. `state`,
   * `answeredAt`) without disturbing its TTL. A call that is no longer there
   * (its hangup was handled first: events are handled concurrently) is left
   * alone rather than recreated as a partial hash with no TTL.
   */
  updateCall(callUuid: string, fields: Readonly<Record<string, string>>): Promise<void>;
  /** Deletes `call:{callUuid}` and removes it from both index sets — the normal hangup cleanup path (04 §3.2). */
  endCall(callUuid: string, nodeId: string, tenantId: string | null): Promise<void>;
  /** For tests and the "50 concurrent calls" proof: every call UUID currently owned by a node. */
  callsForNode(nodeId: string): Promise<string[]>;
  /** S4-04: every node that has ever sent a heartbeat (`fsnodes`), up or not. */
  knownNodeIds(): Promise<string[]>;
  /** S4-04: whether `fsnode:{id}` still exists, i.e. its heartbeat has not expired. */
  isNodeAlive(nodeId: string): Promise<boolean>;
  /**
   * S4-04: claims the handling of a node's death for this replica
   * (`nodelost:{id}`, `SET NX PX`), so exactly one replica sweeps it. False
   * when another replica already has it. The claim lapses after [ttlMs].
   */
  claimNodeLoss(nodeId: string, replicaId: string, ttlMs: number): Promise<boolean>;
  /** S4-04: forgets a node's (now empty) call set once its calls are handled. */
  forgetNodeCalls(nodeId: string): Promise<void>;
  getCall(callUuid: string): Promise<Record<string, string> | undefined>;
  /**
   * Records whose call this is when CHANNEL_CREATE could not say (a call from a
   * trunk: see `normalize.ts`'s `tenantIdOf`). Only fills an empty tenant, so a
   * call never moves between tenants. Does nothing for a call not in the
   * registry.
   *
   * Returns the call as it stands when this attached the tenant, so the caller
   * can announce it (`call.channel.identified`); undefined when the call
   * already had a tenant or is gone.
   */
  attachTenant(callUuid: string, tenantId: string): Promise<LiveCall | undefined>;
  /** The call's tenant as the registry has it; null when unknown or the call is gone. */
  tenantOf(callUuid: string): Promise<string | null>;
  /**
   * The tenant's live calls (S5-08: api-gateway's live-calls snapshot, through
   * `GET /internal/v1/tenants/:tenantId/calls`). Index entries whose call hash
   * has gone (its safety TTL passed with no hangup seen) are dropped from the
   * index as they are found.
   */
  callsForTenant(tenantId: string): Promise<LiveCall[]>;
  /**
   * Every node id whose `fsnode:{id}` key currently exists with `status: up`
   * (04 §3.1: "A node is alive iff `fsnode:{id}` exists and its status is
   * up") — a `draining` or TTL-expired node is excluded, since neither
   * should receive a new affinity lease (S2-12; 04 §3.3: "The node is chosen
   * by least load among live nodes").
   */
  liveNodeIds(): Promise<string[]>;
  /**
   * S9-12: holds a parking slot for a call being parked, across every replica, for `ttlMs`.
   * False when someone else holds it: parking into a slot that is taken would retrieve the call
   * parked there instead (`mod_valet_parking` decides by the slot), joining two callers.
   */
  reserveParkingSlot(
    tenantId: string,
    lotId: string,
    slot: number,
    ttlMs: number,
  ): Promise<boolean>;
}

export interface NodeState {
  readonly nodeId: string;
  /** `down` when `fsnode:{id}` is gone (no heartbeat within its TTL). */
  readonly status: 'up' | 'draining' | 'down';
  /** Whether the node is marked draining, which a `down` node can also be. */
  readonly draining: boolean;
  /** Calls the registry has on the node (`node:{id}:calls`). */
  readonly calls: number;
  /**
   * S4-12: the load its last FreeSWITCH `HEARTBEAT` reported, null until one has (every 20 s by
   * default) and when the node is down.
   */
  readonly sessions: number | null;
  readonly maxSessions: number | null;
  readonly cpuIdlePercent: number | null;
  readonly sessionsPerSecond: number | null;
  readonly uptimeSeconds: number | null;
  /** When that heartbeat arrived (RFC 3339). */
  readonly heartbeatAt: string | null;
}

/** `fsnode:{id}` fields a FreeSWITCH `HEARTBEAT` fills (S4-12). */
const STAT_FIELDS = [
  'sessions',
  'maxSessions',
  'cpuIdlePercent',
  'sessionsPerSecond',
  'uptimeSeconds',
  'heartbeatAt',
] as const;

export interface CallRecord {
  readonly callUuid: string;
  readonly nodeId: string;
  readonly tenantId: string | null;
  readonly direction: 'inbound' | 'outbound';
  readonly state: 'ringing' | 'answered' | 'held';
  readonly startedAt: string;
  readonly from: string;
  readonly to: string;
  /** S5-15: the extension this channel is the leg of, when the node vouches for it (`normalize.ts`). */
  readonly extension: string | null;
  /** S5-15: `cuc_rec_controls`, what the recording buttons may do on the call. */
  readonly controls: RecordingControls;
  /**
   * S4-04: the SIP Call-ID of this leg's dialog with OpenSIPs (the edge keeps
   * it, no topology-hiding rewrite), so the edge can end the dialog if the
   * node dies. Null when the event did not carry one.
   */
  readonly sipCallId?: string | null;
}

/** HSET only when the hash exists, in one step (no read-then-write race with a hangup). */
const UPDATE_IF_EXISTS = `if redis.call('EXISTS', KEYS[1]) == 1 then return redis.call('HSET', KEYS[1], unpack(ARGV)) end return 0`;

/**
 * Sets the tenant of a call that has none yet (`''`), indexes it, and returns
 * the whole hash (as a flat field/value list). A missing hash (HGET gives
 * false) or one that already has a tenant is left alone, and gives an empty list.
 */
const ATTACH_TENANT = `if redis.call('HGET', KEYS[1], 'tenant') == '' then redis.call('HSET', KEYS[1], 'tenant', ARGV[1]) redis.call('SADD', KEYS[2], ARGV[2]) return redis.call('HGETALL', KEYS[1]) end return {}`;

/**
 * KEYS: fsnode:{id}, fsnodes:draining, fsnodes. ARGV: node id, TTL (ms), then field/value pairs
 * (S4-12: a FreeSWITCH HEARTBEAT's figures) to set as well.
 */
const HEARTBEAT = `local status = 'up' if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then status = 'draining' end redis.call('HSET', KEYS[1], 'status', status) for i = 3, #ARGV, 2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1]) end redis.call('PEXPIRE', KEYS[1], ARGV[2]) redis.call('SADD', KEYS[3], ARGV[1]) return status`;

/** KEYS: fsnode:{id}, fsnodes:draining. ARGV: node id, '1' to drain or '0' to undrain. */
const SET_DRAINING = `local status = 'up' if ARGV[2] == '1' then redis.call('SADD', KEYS[2], ARGV[1]) status = 'draining' else redis.call('SREM', KEYS[2], ARGV[1]) end if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('HSET', KEYS[1], 'status', status) end return status`;

/** One live call as the registry holds it, for readers outside this service. */
export interface LiveCall {
  readonly callUuid: string;
  readonly nodeId: string;
  readonly tenantId: string;
  readonly direction: 'inbound' | 'outbound';
  readonly state: 'ringing' | 'answered' | 'held';
  /** Unix milliseconds, as stored (04 §3). */
  readonly startedAt: number;
  readonly answeredAt: number | null;
  readonly from: string;
  readonly to: string;
  readonly bridgedTo: string | null;
  /**
   * Whether the channel is being recorded now (RECORD_START/RECORD_STOP), and (S5-15) whether
   * that recording is paused (`CUSTOM cuc::recording`).
   */
  readonly recording: 'on' | 'off' | 'paused';
  /** S5-15: the extension this channel is the leg of, when the node vouches for it. */
  readonly extension: string | null;
  /** S5-15: what the recording buttons may do on the call (`none` when nothing). */
  readonly controls: RecordingControls;
  /** G-119 (3): the queue this leg is in (a caller waiting or talking, or the agent answering). */
  readonly queueId: string | null;
  /** S9-14: where the leg is parked, while it is. */
  readonly parked: { readonly parkingLotId: string; readonly slot: number } | null;
}

/**
 * Reads one `call:{uuid}` hash into a {@link LiveCall}. Unknown values fall back
 * to the safe reading rather than failing the whole list: this is a live view,
 * and one odd row must not blank it.
 */
export function toLiveCall(
  callUuid: string,
  tenantId: string,
  hash: Record<string, string>,
): LiveCall {
  const millis = (value: string | undefined): number | null => {
    if (value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const state = hash['state'];
  const recording = hash['recording'];
  return {
    callUuid,
    nodeId: hash['node'] ?? '',
    tenantId,
    direction: hash['direction'] === 'outbound' ? 'outbound' : 'inbound',
    state: state === 'answered' || state === 'held' ? state : 'ringing',
    startedAt: millis(hash['startedAt']) ?? 0,
    answeredAt: millis(hash['answeredAt']),
    from: hash['from'] ?? '',
    to: hash['to'] ?? '',
    bridgedTo:
      hash['bridgedTo'] === undefined || hash['bridgedTo'] === '' ? null : hash['bridgedTo'],
    recording: recording === 'on' || recording === 'paused' ? recording : 'off',
    extension: hash['ext'] === undefined || hash['ext'] === '' ? null : hash['ext'],
    controls: parseRecordingControls(hash['controls']),
    queueId: hash['queue'] === undefined || hash['queue'] === '' ? null : hash['queue'],
    parked:
      hash['parkedLot'] !== undefined &&
      hash['parkedLot'] !== '' &&
      Number.isInteger(Number(hash['parkedSlot'] ?? ''))
        ? { parkingLotId: hash['parkedLot'], slot: Number(hash['parkedSlot']) }
        : null,
  };
}

export function createCallRegistry(redis: Redis, keyPrefix: string): CallRegistry {
  const k = (key: string): string => `${keyPrefix}${key}`;

  return {
    async heartbeat(nodeId, ttlMs, stats) {
      const fields =
        stats === undefined
          ? []
          : [
              ...Object.entries(stats).flatMap(([field, value]) => [field, String(value)]),
              'heartbeatAt',
              new Date().toISOString(),
            ];
      await redis.eval(
        HEARTBEAT,
        3,
        k(`fsnode:${nodeId}`),
        k('fsnodes:draining'),
        k('fsnodes'),
        nodeId,
        ttlMs,
        ...fields,
      );
    },

    async setDraining(nodeId, draining) {
      await redis.eval(
        SET_DRAINING,
        2,
        k(`fsnode:${nodeId}`),
        k('fsnodes:draining'),
        nodeId,
        draining ? '1' : '0',
      );
    },

    async nodeStates(nodeIds) {
      if (nodeIds.length === 0) return [];
      const pipeline = redis.pipeline();
      for (const nodeId of nodeIds) {
        pipeline.hmget(k(`fsnode:${nodeId}`), 'status', ...STAT_FIELDS);
        pipeline.sismember(k('fsnodes:draining'), nodeId);
        pipeline.scard(k(`node:${nodeId}:calls`));
      }
      const results = (await pipeline.exec()) ?? [];
      const value = (index: number): unknown => {
        const entry = results[index];
        if (entry === undefined || entry[0] !== null) throw entry?.[0] ?? new Error('no reply');
        return entry[1];
      };
      return nodeIds.map((nodeId, i) => {
        const [status, ...stats] = value(i * 3) as (string | null)[];
        const draining = value(i * 3 + 1) === 1;
        const up = status !== null && status !== undefined;
        const stat = (index: number): number | null => {
          const raw = up ? stats[index] : null;
          if (raw === null || raw === undefined || raw === '') return null;
          const parsed = Number(raw);
          return Number.isFinite(parsed) ? parsed : null;
        };
        const heartbeatAt = up ? (stats[5] ?? null) : null;
        return {
          nodeId,
          status: up ? (draining ? 'draining' : 'up') : 'down',
          draining,
          calls: Number(value(i * 3 + 2)),
          sessions: stat(0),
          maxSessions: stat(1),
          cpuIdlePercent: stat(2),
          sessionsPerSecond: stat(3),
          uptimeSeconds: stat(4),
          heartbeatAt: heartbeatAt === '' ? null : heartbeatAt,
        };
      });
    },

    async createCall(call, safetyTtlMs) {
      const key = k(`call:${call.callUuid}`);
      const tx = redis
        .multi()
        .hset(key, {
          node: call.nodeId,
          tenant: call.tenantId ?? '',
          direction: call.direction,
          state: call.state,
          startedAt: call.startedAt,
          from: call.from,
          to: call.to,
          ext: call.extension ?? '',
          controls: call.controls,
          sipCallId: call.sipCallId ?? '',
        })
        .pexpire(key, safetyTtlMs)
        .sadd(k(`node:${call.nodeId}:calls`), call.callUuid);
      if (call.tenantId !== null) tx.sadd(k(`tenant:${call.tenantId}:calls`), call.callUuid);
      await tx.exec();
    },

    async updateCall(callUuid, fields) {
      // HSET never touches a key's TTL, so this leaves the 6h safety TTL
      // `createCall` set alone rather than resetting it back to full.
      const args = Object.entries(fields).flat();
      if (args.length === 0) return;
      await redis.eval(UPDATE_IF_EXISTS, 1, k(`call:${callUuid}`), ...args);
    },

    async endCall(callUuid, nodeId, tenantId) {
      const tx = redis
        .multi()
        .del(k(`call:${callUuid}`))
        .srem(k(`node:${nodeId}:calls`), callUuid);
      if (tenantId !== null) tx.srem(k(`tenant:${tenantId}:calls`), callUuid);
      await tx.exec();
    },

    async callsForNode(nodeId) {
      return redis.smembers(k(`node:${nodeId}:calls`));
    },

    async knownNodeIds() {
      return redis.smembers(k('fsnodes'));
    },

    async isNodeAlive(nodeId) {
      return (await redis.exists(k(`fsnode:${nodeId}`))) === 1;
    },

    async claimNodeLoss(nodeId, replicaId, ttlMs) {
      return (await redis.set(k(`nodelost:${nodeId}`), replicaId, 'PX', ttlMs, 'NX')) === 'OK';
    },

    async forgetNodeCalls(nodeId) {
      await redis.del(k(`node:${nodeId}:calls`));
    },

    async getCall(callUuid) {
      const record = await redis.hgetall(k(`call:${callUuid}`));
      return Object.keys(record).length === 0 ? undefined : record;
    },

    async attachTenant(callUuid, tenantId) {
      const flat = (await redis.eval(
        ATTACH_TENANT,
        2,
        k(`call:${callUuid}`),
        k(`tenant:${tenantId}:calls`),
        tenantId,
        callUuid,
      )) as string[];
      if (flat.length === 0) return undefined;
      const hash: Record<string, string> = {};
      for (let i = 0; i + 1 < flat.length; i += 2) hash[flat[i] ?? ''] = flat[i + 1] ?? '';
      return toLiveCall(callUuid, tenantId, hash);
    },

    async tenantOf(callUuid) {
      const tenant = await redis.hget(k(`call:${callUuid}`), 'tenant');
      return tenant === null || tenant === '' ? null : tenant;
    },

    async callsForTenant(tenantId) {
      const indexKey = k(`tenant:${tenantId}:calls`);
      const callUuids = await redis.smembers(indexKey);
      if (callUuids.length === 0) return [];

      const pipeline = redis.pipeline();
      for (const callUuid of callUuids) pipeline.hgetall(k(`call:${callUuid}`));
      const results = (await pipeline.exec()) ?? [];

      const calls: LiveCall[] = [];
      const stale: string[] = [];
      callUuids.forEach((callUuid, index) => {
        const entry = results[index];
        const hash =
          entry !== undefined && entry[0] === null ? (entry[1] as Record<string, string>) : {};
        // A hash whose tenant is another one would be a bug elsewhere; never show it here.
        if (Object.keys(hash).length === 0 || hash['tenant'] !== tenantId) {
          stale.push(callUuid);
          return;
        }
        calls.push(toLiveCall(callUuid, tenantId, hash));
      });
      if (stale.length > 0) await redis.srem(indexKey, ...stale);
      return calls.sort((a, b) => a.startedAt - b.startedAt);
    },

    async liveNodeIds() {
      const nodeIds = await redis.smembers(k('fsnodes'));
      if (nodeIds.length === 0) return [];

      const pipeline = redis.pipeline();
      for (const nodeId of nodeIds) pipeline.hget(k(`fsnode:${nodeId}`), 'status');
      const results = await pipeline.exec();

      return nodeIds.filter((_nodeId, index) => {
        const entry = results?.[index];
        return entry !== undefined && entry[0] === null && entry[1] === 'up';
      });
    },

    async reserveParkingSlot(tenantId, lotId, slot, ttlMs) {
      const set = await redis.set(
        k(`parkslot:${tenantId}:${lotId}:${String(slot)}`),
        '1',
        'PX',
        ttlMs,
        'NX',
      );
      return set === 'OK';
    },
  };
}
