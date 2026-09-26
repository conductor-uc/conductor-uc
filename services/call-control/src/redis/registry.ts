import { parseRecordingControls, type RecordingControls } from '@cuc/api-contracts';
import type { Redis } from 'ioredis';

/**
 * The Redis call/node registry (04 §3.1, §3.2) — the one piece of durable-ish
 * state this service owns. Every key is prefixed with `options.keyPrefix`
 * (04 §3: "All keys are prefixed with `cuc:{env}:`"; `config.ts`'s
 * `REDIS_KEY_PREFIX`).
 */
export interface CallRegistry {
  /** Writes/refreshes `fsnode:{id}` (04 §3.1) and adds it to the `fsnodes` set. */
  heartbeat(nodeId: string, ttlMs: number): Promise<void>;
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
}

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
}

/** HSET only when the hash exists, in one step (no read-then-write race with a hangup). */
const UPDATE_IF_EXISTS = `if redis.call('EXISTS', KEYS[1]) == 1 then return redis.call('HSET', KEYS[1], unpack(ARGV)) end return 0`;

/**
 * Sets the tenant of a call that has none yet (`''`), indexes it, and returns
 * the whole hash (as a flat field/value list). A missing hash (HGET gives
 * false) or one that already has a tenant is left alone, and gives an empty list.
 */
const ATTACH_TENANT = `if redis.call('HGET', KEYS[1], 'tenant') == '' then redis.call('HSET', KEYS[1], 'tenant', ARGV[1]) redis.call('SADD', KEYS[2], ARGV[2]) return redis.call('HGETALL', KEYS[1]) end return {}`;

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
  };
}

export function createCallRegistry(redis: Redis, keyPrefix: string): CallRegistry {
  const k = (key: string): string => `${keyPrefix}${key}`;

  return {
    async heartbeat(nodeId, ttlMs) {
      const key = k(`fsnode:${nodeId}`);
      await redis
        .multi()
        .hset(key, { status: 'up' })
        .pexpire(key, ttlMs)
        .sadd(k('fsnodes'), nodeId)
        .exec();
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
  };
}
