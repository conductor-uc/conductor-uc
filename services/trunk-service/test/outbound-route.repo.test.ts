import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { crossTenantProbe, databaseOrSkipReason } from '@cuc/testing';

import { InvalidOutboundRouteError } from '../src/domain/outbound-route.js';
import { OutboundRouteNotFoundError } from '../src/repo/outbound-route.repo.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();

describe.skipIf(skipReason !== undefined)('outbound route repo', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
  });

  function ctxFor(tenantId: string) {
    return { tenantId };
  }

  const baseInput = {
    priority: 0,
    pattern: '+1',
    trunkIds: [crypto.randomUUID(), crypto.randomUUID()],
    strip: 1,
    prepend: '+1',
  };

  it('creates an outbound route with ordered trunk ids', async () => {
    const tenantId = crypto.randomUUID();
    const created = await h.outboundRoutes.create(ctxFor(tenantId), baseInput);

    expect(created).toMatchObject({
      priority: 0,
      pattern: '+1',
      trunkIds: baseInput.trunkIds,
      strip: 1,
      prepend: '+1',
    });

    const row = await h.db.kysely
      .selectFrom('outbound_routes')
      .selectAll()
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(row.tenant_id).toBe(tenantId);
  });

  it('defaults strip to 0 and prepend to null', async () => {
    const tenantId = crypto.randomUUID();
    const created = await h.outboundRoutes.create(ctxFor(tenantId), {
      priority: 1,
      pattern: '',
      trunkIds: [crypto.randomUUID()],
    });
    expect(created.strip).toBe(0);
    expect(created.prepend).toBeNull();
  });

  it('rejects a malformed pattern', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.outboundRoutes.create(ctxFor(tenantId), { ...baseInput, pattern: '1800' }),
    ).rejects.toThrow(InvalidOutboundRouteError);
  });

  it('rejects an empty trunk list', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.outboundRoutes.create(ctxFor(tenantId), { ...baseInput, trunkIds: [] }),
    ).rejects.toThrow(InvalidOutboundRouteError);
  });

  it('rejects a duplicate trunk id in the same route', async () => {
    const tenantId = crypto.randomUUID();
    const trunkId = crypto.randomUUID();
    await expect(
      h.outboundRoutes.create(ctxFor(tenantId), { ...baseInput, trunkIds: [trunkId, trunkId] }),
    ).rejects.toThrow(InvalidOutboundRouteError);
  });

  it('rejects a negative priority or strip', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.outboundRoutes.create(ctxFor(tenantId), { ...baseInput, priority: -1 }),
    ).rejects.toThrow(InvalidOutboundRouteError);
    await expect(
      h.outboundRoutes.create(ctxFor(tenantId), { ...baseInput, strip: -1 }),
    ).rejects.toThrow(InvalidOutboundRouteError);
  });

  it('lists routes ordered by priority', async () => {
    const tenantId = crypto.randomUUID();
    await h.outboundRoutes.create(ctxFor(tenantId), { ...baseInput, priority: 5 });
    await h.outboundRoutes.create(ctxFor(tenantId), { ...baseInput, priority: 1 });

    const rows = await h.outboundRoutes.list(ctxFor(tenantId));
    expect(rows.map((r) => r.priority)).toEqual([1, 5]);
  });

  it('updates the trunk order and prepend', async () => {
    const tenantId = crypto.randomUUID();
    const created = await h.outboundRoutes.create(ctxFor(tenantId), baseInput);
    const newTrunkIds = [baseInput.trunkIds[1]!, baseInput.trunkIds[0]!];

    const updated = await h.outboundRoutes.update(ctxFor(tenantId), created.id, {
      trunkIds: newTrunkIds,
      prepend: null,
    });
    expect(updated.trunkIds).toEqual(newTrunkIds);
    expect(updated.prepend).toBeNull();
    expect(updated.pattern).toBe(baseInput.pattern);
  });

  it('404s an update for a nonexistent route', async () => {
    await expect(
      h.outboundRoutes.update(ctxFor(crypto.randomUUID()), crypto.randomUUID(), { priority: 1 }),
    ).rejects.toThrow(OutboundRouteNotFoundError);
  });

  it('removes a route', async () => {
    const tenantId = crypto.randomUUID();
    const created = await h.outboundRoutes.create(ctxFor(tenantId), baseInput);

    await h.outboundRoutes.remove(ctxFor(tenantId), created.id);
    expect(await h.outboundRoutes.findById(ctxFor(tenantId), created.id)).toBeUndefined();
  });

  it('404s removing a nonexistent route', async () => {
    await expect(
      h.outboundRoutes.remove(ctxFor(crypto.randomUUID()), crypto.randomUUID()),
    ).rejects.toThrow(OutboundRouteNotFoundError);
  });

  it('listAll returns routes across every tenant, for projection', async () => {
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();
    const a = await h.outboundRoutes.create(ctxFor(tenantA), baseInput);
    const b = await h.outboundRoutes.create(ctxFor(tenantB), baseInput);

    const all = await h.outboundRoutes.listAll();
    const ids = all.map((r) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  // 05 §2.4: every repository test suite includes a cross-tenant probe.
  crossTenantProbe({
    name: 'outbound_routes',
    seed: async (tenantId) => {
      const created = await h.outboundRoutes.create(ctxFor(tenantId), baseInput);
      return created.id;
    },
    list: (tenantId) => h.outboundRoutes.list(ctxFor(tenantId)),
    findById: (tenantId, id) => h.outboundRoutes.findById(ctxFor(tenantId), id),
    update: (tenantId, id) =>
      h.outboundRoutes
        .update(ctxFor(tenantId), id, { priority: 9 })
        .then(() => 1)
        .catch((error: unknown) => {
          if (error instanceof OutboundRouteNotFoundError) return 0;
          throw error;
        }),
    remove: (tenantId, id) =>
      h.outboundRoutes
        .remove(ctxFor(tenantId), id)
        .then(() => 1)
        .catch((error: unknown) => {
          if (error instanceof OutboundRouteNotFoundError) return 0;
          throw error;
        }),
  });
});
