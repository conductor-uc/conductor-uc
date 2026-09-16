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
  /** Merges fields into an existing `call:{callUuid}` hash (e.g. `state`, `answeredAt`) without disturbing its TTL. */
  updateCall(callUuid: string, fields: Readonly<Record<string, string>>): Promise<void>;
  /** Deletes `call:{callUuid}` and removes it from both index sets — the normal hangup cleanup path (04 §3.2). */
  endCall(callUuid: string, nodeId: string, tenantId: string | null): Promise<void>;
  /** For tests and the "50 concurrent calls" proof: every call UUID currently owned by a node. */
  callsForNode(nodeId: string): Promise<string[]>;
  getCall(callUuid: string): Promise<Record<string, string> | undefined>;
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
        })
        .pexpire(key, safetyTtlMs)
        .sadd(k(`node:${call.nodeId}:calls`), call.callUuid);
      if (call.tenantId !== null) tx.sadd(k(`tenant:${call.tenantId}:calls`), call.callUuid);
      await tx.exec();
    },

    async updateCall(callUuid, fields) {
      // HSET never touches a key's TTL, so this leaves the 6h safety TTL
      // `createCall` set alone rather than resetting it back to full.
      await redis.hset(k(`call:${callUuid}`), fields);
    },

    async endCall(callUuid, nodeId, tenantId) {
      const tx = redis.multi().del(k(`call:${callUuid}`)).srem(k(`node:${nodeId}:calls`), callUuid);
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
  };
}
