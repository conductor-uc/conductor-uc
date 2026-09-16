import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason } from '@cuc/testing';

import { InvalidEmergencyRouteError } from '../src/domain/emergency-route.js';
import { EmergencyRouteNotFoundError } from '../src/repo/emergency-route.repo.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();

describe.skipIf(skipReason !== undefined)('emergency route repo', () => {
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

  it('creates an emergency route for a tenant with no existing one', async () => {
    const tenantId = crypto.randomUUID();
    const trunkId = crypto.randomUUID();

    const created = await h.emergencyRoutes.upsert(ctxFor(tenantId), {
      trunkId,
      numbers: ['911'],
    });

    expect(created).toMatchObject({ tenantId, trunkId, numbers: ['911'] });
    expect(await h.emergencyRoutes.find(ctxFor(tenantId))).toMatchObject({ trunkId });
  });

  it('upserting again updates the same row in place, not a second one', async () => {
    const tenantId = crypto.randomUUID();
    const trunkId1 = crypto.randomUUID();
    const trunkId2 = crypto.randomUUID();

    const first = await h.emergencyRoutes.upsert(ctxFor(tenantId), {
      trunkId: trunkId1,
      numbers: ['911'],
    });
    const second = await h.emergencyRoutes.upsert(ctxFor(tenantId), {
      trunkId: trunkId2,
      numbers: ['911', '988'],
    });

    expect(second.id).toBe(first.id);
    const found = await h.emergencyRoutes.find(ctxFor(tenantId));
    expect(found).toMatchObject({ trunkId: trunkId2, numbers: ['911', '988'] });
  });

  it('rejects an empty numbers list', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.emergencyRoutes.upsert(ctxFor(tenantId), { trunkId: crypto.randomUUID(), numbers: [] }),
    ).rejects.toThrow(InvalidEmergencyRouteError);
  });

  it('rejects a number that is not digits-only (no leading +, G-1 direct-dial)', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.emergencyRoutes.upsert(ctxFor(tenantId), {
        trunkId: crypto.randomUUID(),
        numbers: ['+1911'],
      }),
    ).rejects.toThrow(InvalidEmergencyRouteError);
  });

  it('rejects duplicate numbers', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.emergencyRoutes.upsert(ctxFor(tenantId), {
        trunkId: crypto.randomUUID(),
        numbers: ['911', '911'],
      }),
    ).rejects.toThrow(InvalidEmergencyRouteError);
  });

  it('404s removing a route that does not exist', async () => {
    const tenantId = crypto.randomUUID();
    await expect(h.emergencyRoutes.remove(ctxFor(tenantId))).rejects.toThrow(
      EmergencyRouteNotFoundError,
    );
  });

  it('removes a tenant’s own route', async () => {
    const tenantId = crypto.randomUUID();
    await h.emergencyRoutes.upsert(ctxFor(tenantId), {
      trunkId: crypto.randomUUID(),
      numbers: ['911'],
    });
    await h.emergencyRoutes.remove(ctxFor(tenantId));
    expect(await h.emergencyRoutes.find(ctxFor(tenantId))).toBeUndefined();
  });

  // A singleton resource (no `:id`) doesn't fit `@cuc/testing`'s
  // `crossTenantProbe` shape (it probes an id another tenant might guess) —
  // tenant isolation here means simply that one tenant's own `find()` never
  // sees another's row, which `scoped(ctx)` already guarantees the same way
  // every other table in this codebase relies on it to.
  it("never returns another tenant's emergency route", async () => {
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();
    await h.emergencyRoutes.upsert(ctxFor(tenantA), {
      trunkId: crypto.randomUUID(),
      numbers: ['911'],
    });

    expect(await h.emergencyRoutes.find(ctxFor(tenantB))).toBeUndefined();
  });

  it('lists every route across every tenant via listAll', async () => {
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();
    await h.emergencyRoutes.upsert(ctxFor(tenantA), {
      trunkId: crypto.randomUUID(),
      numbers: ['911'],
    });
    await h.emergencyRoutes.upsert(ctxFor(tenantB), {
      trunkId: crypto.randomUUID(),
      numbers: ['911'],
    });

    const all = await h.emergencyRoutes.listAll();
    expect(all.map((r) => r.tenantId).sort()).toEqual([tenantA, tenantB].sort());
  });
});
