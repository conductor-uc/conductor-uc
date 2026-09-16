import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { registerDidRoutes } from '../src/routes/did.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();
const TEST_INTERNAL_SECRET = 'test-internal-header-secret';

describe.skipIf(skipReason !== undefined)('pbx-config-service DID HTTP routes', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({
      serviceName: 'pbx-config-service',
      logger: h.logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: TEST_INTERNAL_SECRET },
    });
    registerDidRoutes(app, h.dids);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
    h.domains.realms = {};
    h.trunks.known.clear();
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

  async function seedExtension(tenantId: string) {
    h.domains.realms[tenantId] ??= `${tenantId}.platform.test`;
    return h.extensions.create({ tenantId }, { number: '101', displayName: 'Front Desk' });
  }

  describe('POST /v1/tenants/:tenantId/dids', () => {
    it('creates a DID', async () => {
      const tenantId = crypto.randomUUID();
      const trunkId = crypto.randomUUID();
      h.trunks.known.add(`${tenantId}:${trunkId}`);
      const extension = await seedExtension(tenantId);

      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/dids`,
        headers: actorHeaders(tenantId),
        payload: {
          e164: '+15551234567',
          trunkId,
          destinationType: 'extension',
          destinationId: extension.id,
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        e164: '+15551234567',
        trunkId,
        destinationType: 'extension',
        destinationId: extension.id,
      });
    });

    it('400s a malformed E.164 number', async () => {
      const tenantId = crypto.randomUUID();
      const trunkId = crypto.randomUUID();
      h.trunks.known.add(`${tenantId}:${trunkId}`);
      const extension = await seedExtension(tenantId);

      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/dids`,
        headers: actorHeaders(tenantId),
        payload: {
          e164: 'not-a-number',
          trunkId,
          destinationType: 'extension',
          destinationId: extension.id,
        },
      });
      expect(response.statusCode).toBe(400);
    });

    it('400s a trunk that does not exist', async () => {
      const tenantId = crypto.randomUUID();
      const extension = await seedExtension(tenantId);

      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/dids`,
        headers: actorHeaders(tenantId),
        payload: {
          e164: '+15551234567',
          trunkId: crypto.randomUUID(),
          destinationType: 'extension',
          destinationId: extension.id,
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'trunk_not_found' });
    });

    it('409s a duplicate E.164 number', async () => {
      const tenantId = crypto.randomUUID();
      const trunkId = crypto.randomUUID();
      h.trunks.known.add(`${tenantId}:${trunkId}`);
      const extension = await seedExtension(tenantId);
      await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/dids`,
        headers: actorHeaders(tenantId),
        payload: {
          e164: '+15551234567',
          trunkId,
          destinationType: 'extension',
          destinationId: extension.id,
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/dids`,
        headers: actorHeaders(tenantId),
        payload: {
          e164: '+15551234567',
          trunkId,
          destinationType: 'extension',
          destinationId: extension.id,
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'did_number_taken' });
    });
  });

  describe('GET /v1/tenants/:tenantId/dids', () => {
    it('lists a tenant’s DIDs', async () => {
      const tenantId = crypto.randomUUID();
      const trunkId = crypto.randomUUID();
      h.trunks.known.add(`${tenantId}:${trunkId}`);
      const extension = await seedExtension(tenantId);
      await h.dids.create(
        { tenantId },
        {
          e164: '+15551234567',
          trunkId,
          destinationType: 'extension',
          destinationId: extension.id,
        },
      );

      const response = await app.inject({
        method: 'GET',
        url: `/v1/tenants/${tenantId}/dids`,
        headers: actorHeaders(tenantId),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ rows: [{ e164: '+15551234567' }] });
    });
  });

  describe('PATCH /v1/tenants/:tenantId/dids/:id', () => {
    it('rebinds a DID to a different trunk', async () => {
      const tenantId = crypto.randomUUID();
      const trunkA = crypto.randomUUID();
      const trunkB = crypto.randomUUID();
      h.trunks.known.add(`${tenantId}:${trunkA}`);
      h.trunks.known.add(`${tenantId}:${trunkB}`);
      const extension = await seedExtension(tenantId);
      const created = await h.dids.create(
        { tenantId },
        {
          e164: '+15551234567',
          trunkId: trunkA,
          destinationType: 'extension',
          destinationId: extension.id,
        },
      );

      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}/dids/${created.id}`,
        headers: actorHeaders(tenantId),
        payload: { trunkId: trunkB },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ trunkId: trunkB });
    });
  });

  describe('DELETE /v1/tenants/:tenantId/dids/:id', () => {
    it('deletes a DID', async () => {
      const tenantId = crypto.randomUUID();
      const trunkId = crypto.randomUUID();
      h.trunks.known.add(`${tenantId}:${trunkId}`);
      const extension = await seedExtension(tenantId);
      const created = await h.dids.create(
        { tenantId },
        {
          e164: '+15551234567',
          trunkId,
          destinationType: 'extension',
          destinationId: extension.id,
        },
      );

      const response = await app.inject({
        method: 'DELETE',
        url: `/v1/tenants/${tenantId}/dids/${created.id}`,
        headers: actorHeaders(tenantId),
      });
      expect(response.statusCode).toBe(204);
      await expect(h.dids.findById({ tenantId }, created.id)).resolves.toBeUndefined();
    });

    it('404s deleting a DID that does not exist', async () => {
      const tenantId = crypto.randomUUID();
      const response = await app.inject({
        method: 'DELETE',
        url: `/v1/tenants/${tenantId}/dids/${crypto.randomUUID()}`,
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
