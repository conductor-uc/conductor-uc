import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason } from '@cuc/testing';
import { createServer, type Server } from '@cuc/http';

import { registerInternalRoutes } from '../src/routes/internal.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();
const TOKEN = 'test-internal-service-token';

describe.skipIf(skipReason !== undefined)(
  'GET /internal/v1/tenants/:tenantId/extensions/:id',
  () => {
    let h: Harness;
    let app: Server;

    beforeAll(async () => {
      h = await startHarness();
      app = await createServer({ serviceName: 'pbx-config-service', logger: h.logger });
      registerInternalRoutes(app, h.extensions, h.dids, TOKEN);
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

    it('returns the digest credential for a valid token', async () => {
      const tenantId = crypto.randomUUID();
      h.domains.realms[tenantId] = 'tenant-a.platform.test';
      const created = await h.extensions.create(
        { tenantId },
        { number: '101', displayName: 'Front Desk' },
      );

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenantId}/extensions/${created.id}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      const body: {
        extensionId: string;
        number: string;
        username: string;
        ha1: string;
        realm: string;
      } = response.json();
      expect(body).toMatchObject({
        extensionId: created.id,
        number: '101',
        username: '101',
        realm: 'tenant-a.platform.test',
      });
      expect(body.ha1).toHaveLength(32);
      expect(JSON.stringify(body)).not.toMatch(/secret|password/i);
    });

    it('401s with no token', async () => {
      const tenantId = crypto.randomUUID();
      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenantId}/extensions/${crypto.randomUUID()}`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('401s with the wrong token', async () => {
      const tenantId = crypto.randomUUID();
      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenantId}/extensions/${crypto.randomUUID()}`,
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('404s an unknown extension', async () => {
      const tenantId = crypto.randomUUID();
      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenantId}/extensions/${crypto.randomUUID()}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(404);
    });

    it('404s an extension that exists but belongs to a different tenant', async () => {
      const tenantId = crypto.randomUUID();
      const otherTenantId = crypto.randomUUID();
      h.domains.realms[tenantId] = 'tenant-a.platform.test';
      const created = await h.extensions.create(
        { tenantId },
        { number: '101', displayName: 'Front Desk' },
      );

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${otherTenantId}/extensions/${created.id}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(404);
    });
  },
);

describe.skipIf(skipReason !== undefined)('GET /internal/v1/tenants/:tenantId/dids/:id', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({ serviceName: 'pbx-config-service', logger: h.logger });
    registerInternalRoutes(app, h.extensions, h.dids, TOKEN);
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

  it('returns a DID for a valid token', async () => {
    const tenantId = crypto.randomUUID();
    const trunkId = crypto.randomUUID();
    h.trunks.known.add(`${tenantId}:${trunkId}`);
    h.domains.realms[tenantId] = 'tenant-a.platform.test';
    const extension = await h.extensions.create(
      { tenantId },
      { number: '101', displayName: 'Front Desk' },
    );
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
      method: 'GET',
      url: `/internal/v1/tenants/${tenantId}/dids/${created.id}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: created.id,
      e164: '+15551234567',
      trunkId,
      destinationType: 'extension',
      destinationId: extension.id,
    });
  });

  it('401s with no token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${crypto.randomUUID()}/dids/${crypto.randomUUID()}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('404s an unknown DID', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${crypto.randomUUID()}/dids/${crypto.randomUUID()}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it('404s a DID that exists but belongs to a different tenant', async () => {
    const tenantId = crypto.randomUUID();
    const otherTenantId = crypto.randomUUID();
    const trunkId = crypto.randomUUID();
    h.trunks.known.add(`${tenantId}:${trunkId}`);
    h.domains.realms[tenantId] = 'tenant-a.platform.test';
    const extension = await h.extensions.create(
      { tenantId },
      { number: '101', displayName: 'Front Desk' },
    );
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
      method: 'GET',
      url: `/internal/v1/tenants/${otherTenantId}/dids/${created.id}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.statusCode).toBe(404);
  });
});
