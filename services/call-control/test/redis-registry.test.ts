import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redisOrSkipReason } from '@cuc/testing';

import { startHarness, type Harness } from './harness.js';

const skipReason = await redisOrSkipReason();

describe.skipIf(skipReason !== undefined)('call registry (Redis, 04 §3)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  it('writes a node heartbeat with a TTL and lists it in the node set', async () => {
    await h.registry.heartbeat('fs-1', 5_000);

    const ttl = await h.redis.pttl(`${h.keyPrefix}fsnode:fs-1`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5_000);

    const members = await h.redis.smembers(`${h.keyPrefix}fsnodes`);
    expect(members).toContain('fs-1');
  });

  it('reports only nodes whose heartbeat key still exists with status up (S2-12)', async () => {
    await h.registry.heartbeat('fs-live', 5_000);
    // A node that was once seen (still in the `fsnodes` set) but whose
    // heartbeat key has since expired must not count as live.
    await h.redis.sadd(`${h.keyPrefix}fsnodes`, 'fs-expired');
    await h.redis.sadd(`${h.keyPrefix}fsnodes`, 'fs-draining');
    await h.redis.hset(`${h.keyPrefix}fsnode:fs-draining`, { status: 'draining' });

    const live = await h.registry.liveNodeIds();

    expect(live).toContain('fs-live');
    expect(live).not.toContain('fs-expired');
    expect(live).not.toContain('fs-draining');
  });

  it('creates a call, indexes it by node and tenant, and removes it on end', async () => {
    const callUuid = crypto.randomUUID();
    const tenantId = crypto.randomUUID();

    await h.registry.createCall(
      {
        callUuid,
        nodeId: 'fs-1',
        tenantId,
        direction: 'inbound',
        state: 'ringing',
        startedAt: String(Date.now()),
        from: '+15550001111',
        to: '+15551234567',
      },
      6 * 60 * 60 * 1000,
    );

    expect(await h.registry.callsForNode('fs-1')).toContain(callUuid);
    const tenantCalls = await h.redis.smembers(`${h.keyPrefix}tenant:${tenantId}:calls`);
    expect(tenantCalls).toContain(callUuid);

    const record = await h.registry.getCall(callUuid);
    expect(record).toMatchObject({ node: 'fs-1', tenant: tenantId, state: 'ringing' });

    await h.registry.updateCall(callUuid, { state: 'answered' });
    expect(await h.registry.getCall(callUuid)).toMatchObject({ state: 'answered' });

    await h.registry.endCall(callUuid, 'fs-1', tenantId);

    expect(await h.registry.getCall(callUuid)).toBeUndefined();
    expect(await h.registry.callsForNode('fs-1')).not.toContain(callUuid);
    expect(await h.redis.smembers(`${h.keyPrefix}tenant:${tenantId}:calls`)).not.toContain(
      callUuid,
    );
  });

  it('tracks accurately under many concurrently created calls, and cleans up on hangup (stand-in for the "50 concurrent calls" acceptance criterion, per #44)', async () => {
    const callUuids = Array.from({ length: 50 }, () => crypto.randomUUID());

    await Promise.all(
      callUuids.map((callUuid) =>
        h.registry.createCall(
          {
            callUuid,
            nodeId: 'fs-load',
            tenantId: null,
            direction: 'inbound',
            state: 'ringing',
            startedAt: String(Date.now()),
            from: '1000',
            to: '2000',
          },
          6 * 60 * 60 * 1000,
        ),
      ),
    );

    const registered = await h.registry.callsForNode('fs-load');
    expect(new Set(registered).size).toBe(50);

    await Promise.all(callUuids.map((callUuid) => h.registry.endCall(callUuid, 'fs-load', null)));

    expect(await h.registry.callsForNode('fs-load')).toHaveLength(0);
  });

  describe('live calls by tenant (S5-08)', () => {
    async function create(
      tenantId: string | null,
      fields: { from?: string; to?: string; startedAt?: number } = {},
    ): Promise<string> {
      const callUuid = crypto.randomUUID();
      await h.registry.createCall(
        {
          callUuid,
          nodeId: 'fs-1',
          tenantId,
          direction: 'inbound',
          state: 'ringing',
          startedAt: String(fields.startedAt ?? Date.now()),
          from: fields.from ?? '101',
          to: fields.to ?? '102',
        },
        60_000,
      );
      return callUuid;
    }

    it('lists only the tenant own calls, oldest first, with their current state', async () => {
      const tenantId = crypto.randomUUID();
      const other = crypto.randomUUID();
      const second = await create(tenantId, { startedAt: 2_000, from: '103' });
      const first = await create(tenantId, { startedAt: 1_000 });
      await create(other);
      await h.registry.updateCall(first, { state: 'answered', answeredAt: '1500' });
      await h.registry.updateCall(first, { bridgedTo: second, recording: 'on' });

      const calls = await h.registry.callsForTenant(tenantId);

      expect(calls.map((c) => c.callUuid)).toEqual([first, second]);
      expect(calls[0]).toEqual({
        callUuid: first,
        nodeId: 'fs-1',
        tenantId,
        direction: 'inbound',
        state: 'answered',
        startedAt: 1_000,
        answeredAt: 1_500,
        from: '101',
        to: '102',
        bridgedTo: second,
        recording: 'on',
      });
      expect(calls[1]).toMatchObject({ state: 'ringing', answeredAt: null, recording: 'off' });
    });

    it('drops index entries whose call has gone (safety TTL passed with no hangup seen)', async () => {
      const tenantId = crypto.randomUUID();
      const gone = await create(tenantId);
      const live = await create(tenantId);
      await h.redis.del(`${h.keyPrefix}call:${gone}`);

      expect((await h.registry.callsForTenant(tenantId)).map((c) => c.callUuid)).toEqual([live]);
      expect(await h.redis.smembers(`${h.keyPrefix}tenant:${tenantId}:calls`)).toEqual([live]);
    });

    it('attaches a tenant to a call created without one, once, and never moves it', async () => {
      const tenantId = crypto.randomUUID();
      const callUuid = await create(null);
      expect(await h.registry.callsForTenant(tenantId)).toEqual([]);

      expect(await h.registry.tenantOf(callUuid)).toBeNull();
      // The first attach returns the call as it stands; a later one returns nothing.
      expect(await h.registry.attachTenant(callUuid, tenantId)).toMatchObject({
        callUuid,
        tenantId,
        state: 'ringing',
      });
      expect(await h.registry.attachTenant(callUuid, crypto.randomUUID())).toBeUndefined();

      expect((await h.registry.callsForTenant(tenantId)).map((c) => c.callUuid)).toEqual([
        callUuid,
      ]);
      expect(await h.registry.getCall(callUuid)).toMatchObject({ tenant: tenantId });
      expect(await h.registry.tenantOf(callUuid)).toBe(tenantId);
    });

    it('does not recreate a call that has already ended when a late update or attach arrives', async () => {
      const callUuid = crypto.randomUUID();
      await h.registry.updateCall(callUuid, { recording: 'off' });
      expect(await h.registry.attachTenant(callUuid, crypto.randomUUID())).toBeUndefined();
      expect(await h.registry.getCall(callUuid)).toBeUndefined();
      expect(await h.registry.tenantOf(callUuid)).toBeNull();
    });
  });
});
