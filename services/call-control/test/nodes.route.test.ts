import { createServer, type Server } from '@cuc/http';
import { redisOrSkipReason } from '@cuc/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAffinityManager, type AffinityManager } from '../src/affinity/manager.js';
import { createNodeDrain } from '../src/node-drain.js';
import { registerInternalRoutes } from '../src/routes/internal.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = await redisOrSkipReason();
const TOKEN = 'test-internal-service-token';
const auth = { authorization: `Bearer ${TOKEN}` };

/** The outbox's JSON column may come back as text or already parsed. */
function parsed(payload: unknown): unknown {
  return typeof payload === 'string' ? JSON.parse(payload) : payload;
}

describe.skipIf(skipReason !== undefined)('FS node draining (S4-02, G-123)', () => {
  let h: Harness;
  let affinity: AffinityManager;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    affinity = createAffinityManager({
      redis: h.redis,
      keyPrefix: h.keyPrefix,
      callRegistry: h.registry,
      // No node is reloaded here: a missing ESL client is only logged.
      eslClients: new Map(),
      logger: h.logger,
      leaseTtlMs: 30_000,
      renewIntervalMs: 10_000,
    });
    app = await createServer({ serviceName: 'call-control-test', logger: h.logger });
    registerInternalRoutes(
      app,
      affinity,
      TOKEN,
      h.registry,
      createNodeDrain({
        db: h.db.kysely,
        registry: h.registry,
        affinity,
        nodeIds: ['drain-a', 'drain-b'],
        logger: h.logger,
      }),
    );
    await app.ready();
  });

  afterAll(async () => {
    affinity?.stop();
    await app?.close();
    await h?.close();
  });

  beforeEach(async () => {
    await resetSchema(h.db);
    for (const nodeId of ['drain-a', 'drain-b']) {
      await h.registry.setDraining(nodeId, false);
      await h.registry.heartbeat(nodeId, 30_000);
    }
  });

  it('lists the configured nodes with their state, calls and leases', async () => {
    await affinity.acquire('t-1', 'queue', 'q-list', { preferredNodeId: 'drain-a' });

    const response = await app.inject({ method: 'GET', url: '/internal/v1/nodes', headers: auth });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      nodes: [
        { nodeId: 'drain-a', status: 'up', draining: false, calls: 0, leases: 1 },
        { nodeId: 'drain-b', status: 'up', draining: false, calls: 0, leases: 0 },
      ],
    });
    await affinity.release('t-1', 'queue', 'q-list');
  });

  it('drains a node: out of the live set, leases handed over, and the event committed', async () => {
    await affinity.acquire('t-1', 'queue', 'q-1', { preferredNodeId: 'drain-a' });
    await affinity.acquire('t-1', 'conf', 'c-1', { preferredNodeId: 'drain-a' });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/v1/nodes/drain-a/drain',
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      node: { nodeId: 'drain-a', status: 'draining', draining: true, calls: 0, leases: 0 },
      leasesHandedOver: 2,
    });
    expect(await h.registry.liveNodeIds()).not.toContain('drain-a');
    expect(await affinity.getOwner('t-1', 'queue', 'q-1')).toBeUndefined();
    expect((await affinity.acquire('t-1', 'queue', 'q-1')).nodeId).toBe('drain-b');

    const events = await h.db.kysely.selectFrom('outbox').selectAll().execute();
    expect(events.map((event) => [event.type, parsed(event.payload)])).toEqual([
      ['call.node.drain_changed', { nodeId: 'drain-a', draining: true }],
    ]);
    await affinity.release('t-1', 'queue', 'q-1');
  });

  it('undrains a node back into the live set', async () => {
    await app.inject({ method: 'POST', url: '/internal/v1/nodes/drain-b/drain', headers: auth });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/v1/nodes/drain-b/undrain',
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      node: { nodeId: 'drain-b', status: 'up', draining: false },
      leasesHandedOver: 0,
    });
    expect(await h.registry.liveNodeIds()).toContain('drain-b');
    const events = await h.db.kysely.selectFrom('outbox').select('payload').orderBy('id').execute();
    expect(events.map((event) => parsed(event.payload))).toEqual([
      { nodeId: 'drain-b', draining: true },
      { nodeId: 'drain-b', draining: false },
    ]);
  });

  it('refuses an unknown node and a missing token', async () => {
    const unknown = await app.inject({
      method: 'POST',
      url: '/internal/v1/nodes/nope/drain',
      headers: auth,
    });
    expect(unknown.statusCode).toBe(404);
    expect(await h.db.kysely.selectFrom('outbox').selectAll().execute()).toEqual([]);

    const anonymous = await app.inject({ method: 'POST', url: '/internal/v1/nodes/drain-a/drain' });
    expect(anonymous.statusCode).toBe(401);
    expect(await h.registry.liveNodeIds()).toContain('drain-a');
  });
});
