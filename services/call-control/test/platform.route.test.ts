import { createServer, signInternalHeaders, type Server } from '@cuc/http';
import { redisOrSkipReason } from '@cuc/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAffinityManager, type AffinityManager } from '../src/affinity/manager.js';
import { createNodeDrain } from '../src/node-drain.js';
import { registerPlatformRoutes } from '../src/routes/platform.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = await redisOrSkipReason();
const SECRET = 'test-internal-header-secret';
const MASTER = 'master-org';

/** The outbox's JSON column may come back as text or already parsed. */
function parsed(payload: unknown): unknown {
  return typeof payload === 'string' ? JSON.parse(payload) : payload;
}

describe.skipIf(skipReason !== undefined)('operations console node actions (S4-12)', () => {
  let h: Harness;
  let affinity: AffinityManager;
  let app: Server;
  /** Permissions per actor id; nothing else is held. */
  const held = new Map<string, string[]>([
    ['admin', ['platform.operate', 'platform.observe']],
    ['support', ['platform.observe']],
    ['reseller-admin', ['platform.operate']],
  ]);

  beforeAll(async () => {
    h = await startHarness();
    affinity = createAffinityManager({
      redis: h.redis,
      keyPrefix: h.keyPrefix,
      callRegistry: h.registry,
      eslClients: new Map(),
      logger: h.logger,
      leaseTtlMs: 30_000,
      renewIntervalMs: 10_000,
    });
    app = await createServer({
      serviceName: 'call-control-test',
      logger: h.logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
      permissions: (actor, permission) =>
        Promise.resolve(held.get(actor.id)?.includes(permission) ?? false),
    });
    registerPlatformRoutes(
      app,
      createNodeDrain({
        db: h.db.kysely,
        registry: h.registry,
        affinity,
        nodeIds: ['op-a', 'op-b'],
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
    for (const nodeId of ['op-a', 'op-b']) {
      await h.registry.setDraining(nodeId, false);
      await h.registry.heartbeat(nodeId, 30_000);
    }
  });

  function as(actorId: string, orgType: 'master' | 'reseller' = 'master') {
    const orgId = orgType === 'master' ? MASTER : 'reseller-org';
    return signInternalHeaders(SECRET, {
      actorId,
      actorType: 'user',
      orgId,
      orgType,
      ...(orgType === 'reseller' ? { resellerId: orgId } : {}),
      clientIp: '198.51.100.9',
    });
  }

  async function outbox(): Promise<[string, unknown][]> {
    const rows = await h.db.kysely.selectFrom('outbox').selectAll().orderBy('id').execute();
    return rows.map((row) => [row.type, parsed(row.payload)]);
  }

  it('drains and undrains a node for an operator, with an audit event beside each', async () => {
    const drained = await app.inject({
      method: 'POST',
      url: '/v1/platform/nodes/op-a/drain',
      headers: as('admin'),
    });
    expect(drained.statusCode, drained.body).toBe(200);
    expect(drained.json()).toMatchObject({
      nodeId: 'op-a',
      status: 'draining',
      draining: true,
      leasesHandedOver: 0,
    });
    expect(await h.registry.liveNodeIds()).not.toContain('op-a');

    const undrained = await app.inject({
      method: 'POST',
      url: '/v1/platform/nodes/op-a/undrain',
      headers: as('admin'),
    });
    expect(undrained.statusCode).toBe(200);
    expect(undrained.json()).toMatchObject({ status: 'up', draining: false });

    const events = await outbox();
    expect(events.map(([type]) => type)).toEqual([
      'call.node.drain_changed',
      'audit.event.recorded',
      'call.node.drain_changed',
      'audit.event.recorded',
    ]);
    expect(events[1]?.[1]).toMatchObject({
      action: 'platform.node.drained',
      resource: 'fs-node:op-a',
      dataClass: 'config',
    });
    expect(events[3]?.[1]).toMatchObject({ action: 'platform.node.undrained' });
  });

  it('changes a weight: the event for telephony-config and the audit, in one go', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/platform/nodes/op-b/weight',
      headers: as('admin'),
      payload: { weight: 3 },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ nodeId: 'op-b', weight: 3 });
    const events = await outbox();
    expect(events[0]).toEqual(['call.node.weight_changed', { nodeId: 'op-b', weight: 3 }]);
    expect(events[1]?.[1]).toMatchObject({
      action: 'platform.node.weight_changed',
      resource: 'fs-node:op-b',
    });
  });

  it('refuses a weight outside 1 to 999', async () => {
    for (const weight of [0, 1000, 2.5]) {
      const response = await app.inject({
        method: 'PUT',
        url: '/v1/platform/nodes/op-b/weight',
        headers: as('admin'),
        payload: { weight },
      });
      expect(response.statusCode, String(weight)).toBe(400);
    }
    expect(await outbox()).toEqual([]);
  });

  it('refuses support (observe only) and any reseller, and changes nothing', async () => {
    const support = await app.inject({
      method: 'POST',
      url: '/v1/platform/nodes/op-a/drain',
      headers: as('support'),
    });
    expect(support.statusCode).toBe(403);

    // H3 reserves the permission to the master, whatever a role says.
    const reseller = await app.inject({
      method: 'POST',
      url: '/v1/platform/nodes/op-a/drain',
      headers: as('reseller-admin', 'reseller'),
    });
    expect(reseller.statusCode).toBe(403);

    expect(await h.registry.liveNodeIds()).toContain('op-a');
    expect(await outbox()).toEqual([]);
  });

  it('answers 404 for a node that is not configured', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/platform/nodes/nope/drain',
      headers: as('admin'),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'node_not_found' });
  });
});
