import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { registerConferenceRoomRoutes } from '../src/routes/conference-room.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());
const TEST_INTERNAL_SECRET = 'test-internal-header-secret';

describe.skipIf(skipReason !== undefined)('conference room HTTP routes', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({
      serviceName: 'pbx-config-service',
      logger: h.logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: TEST_INTERNAL_SECRET },
    });
    registerConferenceRoomRoutes(app, h.conferenceRooms);
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

  it('every route declares permission and dataClass (CLAUDE.md rule 3), gated by conference_room.manage', () => {
    for (const route of app.registeredRoutes) {
      if (route.url.startsWith('/v1/tenants/:tenantId/conference-rooms')) {
        expect(route.permission, `${route.method} ${route.url}`).not.toBeNull();
        expect(route.dataClass, `${route.method} ${route.url}`).not.toBeNull();
        expect(route.permission).toBe('conference_room.manage');
      }
    }
  });

  it('creates, lists, gets, updates, and deletes a conference room', async () => {
    const tenantId = crypto.randomUUID();

    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/conference-rooms`,
      headers: actorHeaders(tenantId),
      payload: { label: 'All Hands', number: '600', maxMembers: 50 },
    });
    expect(created.statusCode).toBe(201);
    const body: { id: string } = created.json();

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/conference-rooms`,
      headers: actorHeaders(tenantId),
    });
    const listedBody: { rows: unknown[] } = listed.json();
    expect(listedBody.rows).toHaveLength(1);

    const updated = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}/conference-rooms/${body.id}`,
      headers: actorHeaders(tenantId),
      payload: { maxMembers: 25 },
    });
    const updatedBody: { maxMembers: number } = updated.json();
    expect(updatedBody.maxMembers).toBe(25);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/${tenantId}/conference-rooms/${body.id}`,
      headers: actorHeaders(tenantId),
    });
    expect(deleted.statusCode).toBe(204);

    const gone = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/conference-rooms/${body.id}`,
      headers: actorHeaders(tenantId),
    });
    expect(gone.statusCode).toBe(404);
  });

  it('never returns the PIN itself, only pinRequired', async () => {
    const tenantId = crypto.randomUUID();
    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/conference-rooms`,
      headers: actorHeaders(tenantId),
      payload: { label: 'Board Room', number: '601', pin: '1234', maxMembers: 10 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ pinRequired: true });
    expect(JSON.stringify(created.json())).not.toContain('1234');
  });

  it('rejects a duplicate room number with 409', async () => {
    const tenantId = crypto.randomUUID();
    await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/conference-rooms`,
      headers: actorHeaders(tenantId),
      payload: { label: 'Room A', number: '602', maxMembers: 10 },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/conference-rooms`,
      headers: actorHeaders(tenantId),
      payload: { label: 'Room B', number: '602', maxMembers: 10 },
    });
    expect(response.statusCode).toBe(409);
  });

  it('404s getting a conference room in a different tenant', async () => {
    const tenantId = crypto.randomUUID();
    const otherTenantId = crypto.randomUUID();

    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/conference-rooms`,
      headers: actorHeaders(tenantId),
      payload: { label: 'Room', number: '603', maxMembers: 10 },
    });
    const body: { id: string } = created.json();

    const response = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${otherTenantId}/conference-rooms/${body.id}`,
      headers: actorHeaders(otherTenantId),
    });
    expect(response.statusCode).toBe(404);
  });
});
