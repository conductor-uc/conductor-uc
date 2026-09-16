import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason } from '@cuc/testing';
import { createServer, type Server } from '@cuc/http';

import { registerInternalRoutes } from '../src/routes/internal.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();
const TOKEN = 'test-internal-service-token';

const baseInput = {
  name: 'Primary carrier',
  authMode: 'register' as const,
  host: 'sip.carrier.test',
  port: 5060,
  transport: 'udp',
  username: 'trunkuser',
  secret: 's3cret-password',
  codecs: ['PCMU', 'PCMA'],
};

describe.skipIf(skipReason !== undefined)('trunk-service internal routes', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({ serviceName: 'trunk-service', logger: h.logger });
    registerInternalRoutes(app, h.trunks, h.outboundRoutes, TOKEN);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
    h.resellers.resellerIds = {};
  });

  describe('GET /internal/v1/tenants/:tenantId/trunks/:id', () => {
    it('returns the full trunk detail, including the decrypted secret, its IPs, and the caller-ID policy', async () => {
      const tenantId = crypto.randomUUID();
      h.resellers.resellerIds[tenantId] = 'reseller-a';
      const created = await h.trunks.create(
        { tenantId },
        { ...baseInput, callerIdPolicy: { name: 'Acme Corp', number: '+15559990000' } },
      );
      await h.trunks.addIp({ tenantId }, created.id, '203.0.113.0/24');

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenantId}/trunks/${created.id}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      const body: {
        id: string;
        username: string | null;
        secret: string | null;
        ips: string[];
        callerIdPolicy: { name: string | null; number: string | null } | null;
      } = response.json();
      expect(body).toMatchObject({
        id: created.id,
        username: 'trunkuser',
        secret: 's3cret-password',
        ips: ['203.0.113.0/24'],
        callerIdPolicy: { name: 'Acme Corp', number: '+15559990000' },
      });
    });

    it('401s with no token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${crypto.randomUUID()}/trunks/${crypto.randomUUID()}`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('401s with the wrong token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${crypto.randomUUID()}/trunks/${crypto.randomUUID()}`,
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('404s an unknown trunk', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${crypto.randomUUID()}/trunks/${crypto.randomUUID()}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(404);
    });

    it('404s a trunk that exists but belongs to a different tenant', async () => {
      const tenantId = crypto.randomUUID();
      const otherTenantId = crypto.randomUUID();
      h.resellers.resellerIds[tenantId] = 'reseller-a';
      const created = await h.trunks.create({ tenantId }, baseInput);

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${otherTenantId}/trunks/${created.id}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /internal/v1/trunks', () => {
    it('lists every trunk across every tenant', async () => {
      const tenantA = crypto.randomUUID();
      const tenantB = crypto.randomUUID();
      h.resellers.resellerIds[tenantA] = 'reseller-a';
      h.resellers.resellerIds[tenantB] = 'reseller-b';
      const trunkA = await h.trunks.create({ tenantId: tenantA }, baseInput);
      const trunkB = await h.trunks.create(
        { tenantId: tenantB },
        { ...baseInput, name: 'Second carrier' },
      );

      const response = await app.inject({
        method: 'GET',
        url: '/internal/v1/trunks',
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      const body: { rows: { id: string }[] } = response.json();
      expect(body.rows.map((row) => row.id).sort()).toEqual([trunkA.id, trunkB.id].sort());
    });

    it('401s with no token', async () => {
      const response = await app.inject({ method: 'GET', url: '/internal/v1/trunks' });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /internal/v1/tenants/:tenantId/outbound-routes/:id', () => {
    it('returns an outbound route', async () => {
      const tenantId = crypto.randomUUID();
      const created = await h.outboundRoutes.create(
        { tenantId },
        { priority: 0, pattern: '+1', trunkIds: [crypto.randomUUID()] },
      );

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenantId}/outbound-routes/${created.id}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: created.id, pattern: '+1' });
    });

    it('404s an outbound route that exists but belongs to a different tenant', async () => {
      const tenantId = crypto.randomUUID();
      const otherTenantId = crypto.randomUUID();
      const created = await h.outboundRoutes.create(
        { tenantId },
        { priority: 0, pattern: '+1', trunkIds: [crypto.randomUUID()] },
      );

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${otherTenantId}/outbound-routes/${created.id}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /internal/v1/outbound-routes', () => {
    it('lists every outbound route across every tenant', async () => {
      const tenantA = crypto.randomUUID();
      const tenantB = crypto.randomUUID();
      const routeA = await h.outboundRoutes.create(
        { tenantId: tenantA },
        { priority: 0, pattern: '+1', trunkIds: [crypto.randomUUID()] },
      );
      const routeB = await h.outboundRoutes.create(
        { tenantId: tenantB },
        { priority: 0, pattern: '+44', trunkIds: [crypto.randomUUID()] },
      );

      const response = await app.inject({
        method: 'GET',
        url: '/internal/v1/outbound-routes',
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      const body: { rows: { id: string }[] } = response.json();
      expect(body.rows.map((row) => row.id).sort()).toEqual([routeA.id, routeB.id].sort());
    });
  });
});
