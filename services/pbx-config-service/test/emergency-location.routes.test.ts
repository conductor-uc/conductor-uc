import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { registerEmergencyLocationRoutes } from '../src/routes/emergency-location.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();
const TEST_INTERNAL_SECRET = 'test-internal-header-secret';

const VALID_BODY = {
  label: 'Main Office',
  addressLine1: '123 Main St',
  city: 'Springfield',
  state: 'IL',
  postalCode: '62701',
  country: 'US',
};

describe.skipIf(skipReason !== undefined)('emergency location HTTP routes', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({
      serviceName: 'pbx-config-service',
      logger: h.logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: TEST_INTERNAL_SECRET },
    });
    registerEmergencyLocationRoutes(app, h.emergencyLocations);
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

  it('every route declares permission and dataClass (CLAUDE.md rule 3)', () => {
    for (const route of app.registeredRoutes) {
      if (route.url.startsWith('/v1/')) {
        expect(route.permission, `${route.method} ${route.url}`).not.toBeNull();
        expect(route.dataClass, `${route.method} ${route.url}`).not.toBeNull();
      }
    }
  });

  it('creates, lists, gets, updates, and deletes a location', async () => {
    const tenantId = crypto.randomUUID();

    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/emergency-locations`,
      headers: actorHeaders(tenantId),
      payload: VALID_BODY,
    });
    expect(created.statusCode, JSON.stringify(created.json())).toBe(201);
    const location: { id: string } = created.json();

    const list = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/emergency-locations`,
      headers: actorHeaders(tenantId),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ rows: [{ label: 'Main Office' }] });

    const got = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/emergency-locations/${location.id}`,
      headers: actorHeaders(tenantId),
    });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject(VALID_BODY);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}/emergency-locations/${location.id}`,
      headers: actorHeaders(tenantId),
      payload: { label: 'Main Office - Renamed' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ label: 'Main Office - Renamed' });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/${tenantId}/emergency-locations/${location.id}`,
      headers: actorHeaders(tenantId),
    });
    expect(deleted.statusCode).toBe(204);

    const afterDelete = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/emergency-locations/${location.id}`,
      headers: actorHeaders(tenantId),
    });
    expect(afterDelete.statusCode).toBe(404);
  });

  it('400s creating a location with an invalid country', async () => {
    const tenantId = crypto.randomUUID();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/emergency-locations`,
      headers: actorHeaders(tenantId),
      payload: { ...VALID_BODY, country: 'FR' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('404s getting a location that does not exist', async () => {
    const tenantId = crypto.randomUUID();
    const response = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/emergency-locations/${crypto.randomUUID()}`,
      headers: actorHeaders(tenantId),
    });
    expect(response.statusCode).toBe(404);
  });
});
