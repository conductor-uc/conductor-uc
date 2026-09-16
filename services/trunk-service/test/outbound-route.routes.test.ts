import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { registerOutboundRouteRoutes } from '../src/routes/outbound-route.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();
const TEST_INTERNAL_SECRET = 'test-internal-header-secret';

describe.skipIf(skipReason !== undefined)('trunk-service outbound-route HTTP routes', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({
      serviceName: 'trunk-service',
      logger: h.logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: TEST_INTERNAL_SECRET },
    });
    registerOutboundRouteRoutes(app, h.outboundRoutes);
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

  const payload = {
    priority: 0,
    pattern: '+1',
    trunkIds: [crypto.randomUUID(), crypto.randomUUID()],
    strip: 1,
    prepend: '+1',
  };

  describe('POST /v1/tenants/:tenantId/outbound-routes', () => {
    it('creates an outbound route', async () => {
      const tenantId = crypto.randomUUID();
      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/outbound-routes`,
        headers: actorHeaders(tenantId),
        payload,
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        priority: 0,
        pattern: '+1',
        trunkIds: payload.trunkIds,
        strip: 1,
        prepend: '+1',
      });
    });

    it('400s a malformed pattern', async () => {
      const tenantId = crypto.randomUUID();
      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/outbound-routes`,
        headers: actorHeaders(tenantId),
        payload: { ...payload, pattern: '1800' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('400s an empty trunk list', async () => {
      const tenantId = crypto.randomUUID();
      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/outbound-routes`,
        headers: actorHeaders(tenantId),
        payload: { ...payload, trunkIds: [] },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /v1/tenants/:tenantId/outbound-routes', () => {
    it('lists a tenant’s outbound routes', async () => {
      const tenantId = crypto.randomUUID();
      await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/outbound-routes`,
        headers: actorHeaders(tenantId),
        payload,
      });

      const response = await app.inject({
        method: 'GET',
        url: `/v1/tenants/${tenantId}/outbound-routes`,
        headers: actorHeaders(tenantId),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ rows: [{ pattern: '+1' }] });
    });
  });

  describe('PATCH /v1/tenants/:tenantId/outbound-routes/:id', () => {
    it('reorders the trunk list', async () => {
      const tenantId = crypto.randomUUID();
      const createResponse = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/outbound-routes`,
        headers: actorHeaders(tenantId),
        payload,
      });
      const created: { id: string } = createResponse.json();

      const reordered = [payload.trunkIds[1], payload.trunkIds[0]];
      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}/outbound-routes/${created.id}`,
        headers: actorHeaders(tenantId),
        payload: { trunkIds: reordered },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ trunkIds: reordered });
    });
  });

  describe('DELETE /v1/tenants/:tenantId/outbound-routes/:id', () => {
    it('deletes an outbound route', async () => {
      const tenantId = crypto.randomUUID();
      const createResponse = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/outbound-routes`,
        headers: actorHeaders(tenantId),
        payload,
      });
      const created: { id: string } = createResponse.json();

      const response = await app.inject({
        method: 'DELETE',
        url: `/v1/tenants/${tenantId}/outbound-routes/${created.id}`,
        headers: actorHeaders(tenantId),
      });
      expect(response.statusCode).toBe(204);
    });

    it('404s deleting a nonexistent route', async () => {
      const tenantId = crypto.randomUUID();
      const response = await app.inject({
        method: 'DELETE',
        url: `/v1/tenants/${tenantId}/outbound-routes/${crypto.randomUUID()}`,
        headers: actorHeaders(tenantId),
      });
      expect(response.statusCode).toBe(404);
    });
  });

  it('every public route declares permission and dataClass (CLAUDE.md rule 3)', () => {
    for (const route of app.registeredRoutes) {
      if (route.url.startsWith('/v1/')) {
        expect(route.permission, `${route.method} ${route.url}`).not.toBeNull();
        expect(route.dataClass, `${route.method} ${route.url}`).not.toBeNull();
      }
    }
  });
});
