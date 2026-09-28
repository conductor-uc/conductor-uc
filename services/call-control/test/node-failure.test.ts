import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, redisOrSkipReason } from '@cuc/testing';

import { createNodeFailureWatcher } from '../src/node-failure.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await redisOrSkipReason());

function parsePayload(payload: unknown): Record<string, unknown> {
  return typeof payload === 'string'
    ? (JSON.parse(payload) as Record<string, unknown>)
    : (payload as Record<string, unknown>);
}

describe.skipIf(skipReason !== undefined)('when a media node dies (S4-04)', () => {
  let h: Harness;
  const handedOver: string[] = [];

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
    handedOver.length = 0;
  });

  function watcher(
    replicaId = 'replica-a',
    now = () => 1_790_000_100_000,
    extra: { isConnected?: (nodeId: string) => boolean; startupGraceMs?: number } = {},
  ) {
    return createNodeFailureWatcher({
      ...extra,
      registry: h.registry,
      affinity: {
        handOver: (nodeId) => {
          handedOver.push(nodeId);
          return Promise.resolve(2);
        },
      },
      db: h.db.kysely,
      logger: h.logger,
      replicaId,
      now,
    });
  }

  async function call(nodeId: string, tenantId: string | null, sipCallId: string | null) {
    const callUuid = crypto.randomUUID();
    await h.registry.createCall(
      {
        callUuid,
        nodeId,
        tenantId,
        direction: 'inbound',
        state: 'ringing',
        startedAt: '1790000000123',
        from: '+15550001111',
        to: '1001',
        extension: null,
        controls: 'none',
        sipCallId,
      },
      6 * 60 * 60 * 1000,
    );
    return callUuid;
  }

  it("announces every leg of a dead node as lost, clears them, and releases the node's leases", async () => {
    const dead = `fs-dead-${crypto.randomUUID().slice(0, 6)}`;
    const alive = `fs-alive-${crypto.randomUUID().slice(0, 6)}`;
    const tenantId = crypto.randomUUID();
    // Both nodes heartbeat once; only `alive` keeps doing so.
    await h.registry.heartbeat(dead, 1);
    await h.registry.heartbeat(alive, 60_000);
    const answered = await call(dead, tenantId, 'abc@edge');
    await h.registry.updateCall(answered, { state: 'answered', answeredAt: '1790000005000' });
    const trunkLeg = await call(dead, null, null);
    const safe = await call(alive, tenantId, 'def@edge');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const handled = await watcher().runOnce();

    expect(handled).toContain(dead);
    expect(handled).not.toContain(alive);
    expect(handedOver).toEqual([dead]);
    expect(await h.registry.getCall(answered)).toBeUndefined();
    expect(await h.registry.getCall(trunkLeg)).toBeUndefined();
    expect(await h.registry.callsForNode(dead)).toEqual([]);
    expect(await h.registry.getCall(safe)).toBeDefined();
    expect((await h.registry.callsForTenant(tenantId)).map((c) => c.callUuid)).toEqual([safe]);

    const rows = await h.db.kysely
      .selectFrom('outbox')
      .select(['type', 'tenant_id', 'payload'])
      .execute();
    const lost = rows.filter((r) => r.type === 'call.lost');
    expect(lost).toHaveLength(2);
    const mine = lost.find((r) => r.tenant_id === tenantId);
    expect(parsePayload(mine?.payload)).toMatchObject({
      callUuid: answered,
      nodeId: dead,
      direction: 'inbound',
      startedAt: 1_790_000_000_123,
      answeredAt: 1_790_000_005_000,
      detectedAt: 1_790_000_100_000,
      sipCallId: 'abc@edge',
    });
  });

  it('never declares a node dead that this replica is still connected to, nor any while starting up', async () => {
    const quiet = `fs-quiet-${crypto.randomUUID().slice(0, 6)}`;
    await h.registry.heartbeat(quiet, 1);
    const kept = await call(quiet, crypto.randomUUID(), null);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Its heartbeat key lapsed, but the event socket is up: it is alive.
    expect(
      await watcher('a', undefined, { isConnected: (id) => id === quiet }).runOnce(),
    ).not.toContain(quiet);
    // Every node looks dead just after every replica was down; nothing is declared until the grace passes.
    let clock = 1_000;
    const starting = watcher('b', () => clock, { startupGraceMs: 20_000 });
    expect(await starting.runOnce()).toEqual([]);
    expect(await h.registry.getCall(kept)).toBeDefined();
    clock += 20_001;
    expect(await starting.runOnce()).toContain(quiet);
  });

  it('exactly one replica handles a death', async () => {
    const dead = `fs-dead-${crypto.randomUUID().slice(0, 6)}`;
    await h.registry.heartbeat(dead, 1);
    await call(dead, crypto.randomUUID(), null);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const [a, b] = await Promise.all([watcher('a').runOnce(), watcher('b').runOnce()]);
    expect([...a, ...b].filter((id) => id === dead)).toHaveLength(1);
    const lost = await h.db.kysely
      .selectFrom('outbox')
      .select('type')
      .where('type', '=', 'call.lost')
      .execute();
    expect(lost).toHaveLength(1);
  });
});
