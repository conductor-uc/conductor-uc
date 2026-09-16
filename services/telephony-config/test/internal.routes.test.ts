import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason } from '@cuc/testing';
import { createServer, type Server } from '@cuc/http';

import { registerInternalRoutes } from '../src/routes/internal.routes.js';
import { resetSchema, startHarness, TEST_OPENSIPS_SIP_URI, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();
const TOKEN = 'test-internal-service-token';

describe.skipIf(skipReason !== undefined)(
  'GET /internal/v1/tenants/:tenantId/trunks/:id/status',
  () => {
    let h: Harness;
    let app: Server;

    beforeAll(async () => {
      h = await startHarness();
      app = await createServer({ serviceName: 'telephony-config', logger: h.logger });
      registerInternalRoutes(app, h.readModel, h.mi, TEST_OPENSIPS_SIP_URI, TOKEN, h.logger);
      await app.ready();
    });

    afterAll(async () => {
      await app?.close();
      await h?.close();
    });

    afterEach(async () => {
      await resetSchema(h.db);
      h.mi.regListResults = {};
    });

    async function seedTrunk(
      overrides: Partial<Parameters<typeof h.readModel.upsertTrunk>[1]> = {},
    ) {
      const tenantId = crypto.randomUUID();
      const trunkId = crypto.randomUUID();
      await h.readModel.upsertTrunk(h.db.kysely, {
        id: trunkId,
        tenantId,
        name: 'Primary carrier',
        authMode: 'register',
        host: 'sip.carrier.test',
        port: 5060,
        transport: 'udp',
        username: 'trunkuser',
        secret: 's3cret-password',
        fromDomain: 'acme.platform.test',
        status: 'active',
        callerIdName: null,
        callerIdNumber: null,
        ...overrides,
      });
      return { tenantId, trunkId };
    }

    it('returns "registered" for the live scoped shape (confirmed live: `{ Registrant: { state: "REGISTERED_STATE" } }`)', async () => {
      const { tenantId, trunkId } = await seedTrunk();
      h.mi.regListResults['sip:trunkuser@acme.platform.test'] = {
        Registrant: { state: 'REGISTERED_STATE' },
      };

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenantId}/trunks/${trunkId}/status`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'registered' });
    });

    it('also accepts the unscoped `{ Records: [{ State: 3 }] }` shape', async () => {
      const { tenantId, trunkId } = await seedTrunk();
      h.mi.regListResults['sip:trunkuser@acme.platform.test'] = { Records: [{ State: 3 }] };

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenantId}/trunks/${trunkId}/status`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'registered' });
    });

    it('returns "not_registered" when reg_list has no record', async () => {
      const { tenantId, trunkId } = await seedTrunk();

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenantId}/trunks/${trunkId}/status`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'not_registered' });
    });

    it('returns "not_applicable" for an ip-mode trunk', async () => {
      const { tenantId, trunkId } = await seedTrunk({
        authMode: 'ip',
        username: null,
        secret: null,
      });

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenantId}/trunks/${trunkId}/status`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'not_applicable' });
    });

    it('401s with no token', async () => {
      const { tenantId, trunkId } = await seedTrunk();
      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenantId}/trunks/${trunkId}/status`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('404s an unknown trunk', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${crypto.randomUUID()}/trunks/${crypto.randomUUID()}/status`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(404);
    });

    it('404s a trunk that exists but belongs to a different tenant', async () => {
      const { trunkId } = await seedTrunk();
      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${crypto.randomUUID()}/trunks/${trunkId}/status`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(404);
    });
  },
);
