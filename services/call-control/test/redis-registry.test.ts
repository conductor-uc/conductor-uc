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
    expect(await h.redis.smembers(`${h.keyPrefix}tenant:${tenantId}:calls`)).not.toContain(callUuid);
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
});
