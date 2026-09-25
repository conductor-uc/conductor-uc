import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { registerParkingLotRoutes } from '../src/routes/parking-lot.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());
const TEST_INTERNAL_SECRET = 'test-internal-header-secret';

describe.skipIf(skipReason !== undefined)('parking lot HTTP routes', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({
      serviceName: 'pbx-config-service',
      logger: h.logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: TEST_INTERNAL_SECRET },
    });
    registerParkingLotRoutes(app, h.parkingLots);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
  });

  function actorHeaders(tenantId: string) {
    return signInternalHeaders(TEST_INTERNAL_SECRET, {
      actorId: 'user-1',
      actorType: 'user',
      orgId: tenantId,
      orgType: 'tenant',
      tenantId,
    });
  }

  it('every route declares permission and dataClass (CLAUDE.md rule 3), gated by parking_lot.read/.manage (G-10)', () => {
    for (const route of app.registeredRoutes) {
      if (route.url.startsWith('/v1/tenants/:tenantId/parking-lots')) {
        expect(route.permission, `${route.method} ${route.url}`).not.toBeNull();
        expect(route.dataClass, `${route.method} ${route.url}`).not.toBeNull();
        expect(route.permission).toBe(
          route.method === 'GET' || route.method === 'HEAD'
            ? 'parking_lot.read'
            : 'parking_lot.manage',
        );
      }
    }
  });

  it('creates, lists, gets, updates, and deletes a parking lot', async () => {
    const tenantId = crypto.randomUUID();

    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/parking-lots`,
      headers: actorHeaders(tenantId),
      payload: { label: 'Main Lot', slotStart: 700, slotEnd: 719, timeoutSeconds: 120 },
    });
    expect(created.statusCode).toBe(201);
    const body: { id: string } = created.json();

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/parking-lots`,
      headers: actorHeaders(tenantId),
    });
    const listedBody: { rows: unknown[] } = listed.json();
    expect(listedBody.rows).toHaveLength(1);

    const updated = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}/parking-lots/${body.id}`,
      headers: actorHeaders(tenantId),
      payload: { timeoutSeconds: 60 },
    });
    const updatedBody: { timeoutSeconds: number } = updated.json();
    expect(updatedBody.timeoutSeconds).toBe(60);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/${tenantId}/parking-lots/${body.id}`,
      headers: actorHeaders(tenantId),
    });
    expect(deleted.statusCode).toBe(204);

    const gone = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/parking-lots/${body.id}`,
      headers: actorHeaders(tenantId),
    });
    expect(gone.statusCode).toBe(404);
  });

  it('rejects overlapping slot ranges with 409', async () => {
    const tenantId = crypto.randomUUID();
    await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/parking-lots`,
      headers: actorHeaders(tenantId),
      payload: { label: 'Lot A', slotStart: 700, slotEnd: 719, timeoutSeconds: 120 },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/parking-lots`,
      headers: actorHeaders(tenantId),
      payload: { label: 'Lot B', slotStart: 710, slotEnd: 730, timeoutSeconds: 120 },
    });
    expect(response.statusCode).toBe(409);
  });

  it('404s getting a parking lot in a different tenant', async () => {
    const tenantId = crypto.randomUUID();
    const otherTenantId = crypto.randomUUID();

    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/parking-lots`,
      headers: actorHeaders(tenantId),
      payload: { label: 'Lot', slotStart: 700, slotEnd: 719, timeoutSeconds: 120 },
    });
    const body: { id: string } = created.json();

    const response = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${otherTenantId}/parking-lots/${body.id}`,
      headers: actorHeaders(otherTenantId),
    });
    expect(response.statusCode).toBe(404);
  });
});
