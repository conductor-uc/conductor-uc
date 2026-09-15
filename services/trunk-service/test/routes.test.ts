import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@cuc/api-contracts';
import type { Bus } from '@cuc/events';
import { databaseOrSkipReason } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { registerTrunkRoutes } from '../src/routes/trunk.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();
const TEST_INTERNAL_SECRET = 'test-internal-header-secret';

/**
 * Records every envelope handed to `publish` rather than opening a real NATS
 * connection — HTTP route behaviour is what this file tests (matches
 * pbx-config-service's `routes.test.ts`, S1-09).
 */
function fakeBus(): Bus & { published: EventEnvelope[] } {
  const published: EventEnvelope[] = [];
  return {
    published,
    js: undefined as never,
    jsm: undefined as never,
    connection: undefined as never,
    publish: (envelope: EventEnvelope) => {
      published.push(envelope);
      return Promise.resolve({ sequence: published.length, duplicate: false });
    },
    ensureStreams: () => Promise.resolve(),
    ping: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  };
}

describe.skipIf(skipReason !== undefined)('trunk-service HTTP routes', () => {
  let h: Harness;
  let bus: ReturnType<typeof fakeBus>;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    bus = fakeBus();
    app = await createServer({
      serviceName: 'trunk-service',
      logger: h.logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: TEST_INTERNAL_SECRET },
    });
    registerTrunkRoutes(app, h.trunks, bus);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
    h.resellers.resellerIds = {};
    bus.published.length = 0;
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
    name: 'Primary carrier',
    authMode: 'register',
    host: 'sip.carrier.test',
    port: 5060,
    transport: 'udp',
    username: 'trunkuser',
    secret: 's3cret-password',
    codecs: ['PCMU', 'PCMA'],
  };

  describe('POST /v1/tenants/:tenantId/trunks', () => {
    it('creates a trunk and never returns the secret', async () => {
      const tenantId = crypto.randomUUID();
      h.resellers.resellerIds[tenantId] = 'reseller-a';

      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/trunks`,
        headers: actorHeaders(tenantId),
        payload,
      });

      expect(response.statusCode).toBe(201);
      const body: Record<string, unknown> = response.json();
      expect(body).toMatchObject({ name: 'Primary carrier', username: 'trunkuser' });
      expect(JSON.stringify(body)).not.toMatch(/secret/i);
      expect(JSON.stringify(body)).not.toContain('s3cret-password');
    });

    it('400s a request missing required fields', async () => {
      const tenantId = crypto.randomUUID();
      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/trunks`,
        headers: actorHeaders(tenantId),
        payload: { name: 'Broken' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('409s a duplicate trunk name', async () => {
      const tenantId = crypto.randomUUID();
      h.resellers.resellerIds[tenantId] = 'reseller-a';
      await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/trunks`,
        headers: actorHeaders(tenantId),
        payload,
      });

      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/trunks`,
        headers: actorHeaders(tenantId),
        payload,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'trunk_name_taken' });
    });

    it('409s when the tenant has no owning reseller yet', async () => {
      const tenantId = crypto.randomUUID();

      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/trunks`,
        headers: actorHeaders(tenantId),
        payload,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'tenant_reseller_not_found' });
    });
  });

  describe('GET /v1/tenants/:tenantId/trunks', () => {
    it('lists trunks for the tenant', async () => {
      const tenantId = crypto.randomUUID();
      h.resellers.resellerIds[tenantId] = 'reseller-a';
      await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/trunks`,
        headers: actorHeaders(tenantId),
        payload,
      });

      const response = await app.inject({
        method: 'GET',
        url: `/v1/tenants/${tenantId}/trunks`,
        headers: actorHeaders(tenantId),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ rows: [{ name: 'Primary carrier' }] });
    });
  });

  describe('PATCH /v1/tenants/:tenantId/trunks/:id', () => {
    it('updates fields', async () => {
      const tenantId = crypto.randomUUID();
      h.resellers.resellerIds[tenantId] = 'reseller-a';
      const created = await app
        .inject({
          method: 'POST',
          url: `/v1/tenants/${tenantId}/trunks`,
          headers: actorHeaders(tenantId),
          payload,
        })
        .then((r) => r.json<{ id: string }>());

      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}/trunks/${created.id}`,
        headers: actorHeaders(tenantId),
        payload: { maxChannels: 5 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ maxChannels: 5 });
    });

    it('404s an unknown trunk', async () => {
      const tenantId = crypto.randomUUID();

      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}/trunks/${crypto.randomUUID()}`,
        headers: actorHeaders(tenantId),
        payload: { name: 'X' },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('DELETE /v1/tenants/:tenantId/trunks/:id', () => {
    it('deletes a trunk', async () => {
      const tenantId = crypto.randomUUID();
      h.resellers.resellerIds[tenantId] = 'reseller-a';
      const created = await app
        .inject({
          method: 'POST',
          url: `/v1/tenants/${tenantId}/trunks`,
          headers: actorHeaders(tenantId),
          payload,
        })
        .then((r) => r.json<{ id: string }>());

      const response = await app.inject({
        method: 'DELETE',
        url: `/v1/tenants/${tenantId}/trunks/${created.id}`,
        headers: actorHeaders(tenantId),
      });

      expect(response.statusCode).toBe(204);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/v1/tenants/${tenantId}/trunks/${created.id}`,
            headers: actorHeaders(tenantId),
          })
        ).statusCode,
      ).toBe(404);
    });
  });

  describe('trunk IPs', () => {
    it('adds, lists, and removes an IP', async () => {
      const tenantId = crypto.randomUUID();
      h.resellers.resellerIds[tenantId] = 'reseller-a';
      const created = await app
        .inject({
          method: 'POST',
          url: `/v1/tenants/${tenantId}/trunks`,
          headers: actorHeaders(tenantId),
          payload: { ...payload, authMode: 'ip', username: undefined, secret: undefined },
        })
        .then((r) => r.json<{ id: string }>());

      const added = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/trunks/${created.id}/ips`,
        headers: actorHeaders(tenantId),
        payload: { cidr: '203.0.113.0/24' },
      });
      expect(added.statusCode).toBe(201);
      const ip: { id: string } = added.json();

      const listed = await app.inject({
        method: 'GET',
        url: `/v1/tenants/${tenantId}/trunks/${created.id}/ips`,
        headers: actorHeaders(tenantId),
      });
      expect(listed.json()).toMatchObject({ rows: [{ cidr: '203.0.113.0/24' }] });

      const removed = await app.inject({
        method: 'DELETE',
        url: `/v1/tenants/${tenantId}/trunks/${created.id}/ips/${ip.id}`,
        headers: actorHeaders(tenantId),
      });
      expect(removed.statusCode).toBe(204);
    });

    it('400s a malformed CIDR', async () => {
      const tenantId = crypto.randomUUID();
      h.resellers.resellerIds[tenantId] = 'reseller-a';
      const created = await app
        .inject({
          method: 'POST',
          url: `/v1/tenants/${tenantId}/trunks`,
          headers: actorHeaders(tenantId),
          payload: { ...payload, authMode: 'ip', username: undefined, secret: undefined },
        })
        .then((r) => r.json<{ id: string }>());

      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/trunks/${created.id}/ips`,
        headers: actorHeaders(tenantId),
        payload: { cidr: 'not-an-ip' },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /v1/tenants/:tenantId/trunks/:id/reveal', () => {
    it('returns the plaintext credential and publishes an audit event', async () => {
      const tenantId = crypto.randomUUID();
      h.resellers.resellerIds[tenantId] = 'reseller-a';
      const created = await app
        .inject({
          method: 'POST',
          url: `/v1/tenants/${tenantId}/trunks`,
          headers: actorHeaders(tenantId),
          payload,
        })
        .then((r) => r.json<{ id: string }>());

      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/trunks/${created.id}/reveal`,
        headers: actorHeaders(tenantId),
        payload: { reason: 'confirming carrier registration' },
      });

      expect(response.statusCode).toBe(200);
      const body: { username: string; secret: string } = response.json();
      expect(body).toEqual({ username: 'trunkuser', secret: 's3cret-password' });

      expect(bus.published).toHaveLength(1);
      expect(bus.published[0]).toMatchObject({
        type: 'audit.event.recorded',
        actor: { type: 'user', id: 'user-1', orgId: tenantId },
        data: {
          action: 'trunk.credential.revealed',
          resource: created.id,
          dataClass: 'secret',
          targetOrgId: tenantId,
          reason: 'confirming carrier registration',
        },
      });
    });

    it('rejects a reveal with no identified actor', async () => {
      const tenantId = crypto.randomUUID();
      h.resellers.resellerIds[tenantId] = 'reseller-a';
      const created = await app
        .inject({
          method: 'POST',
          url: `/v1/tenants/${tenantId}/trunks`,
          headers: actorHeaders(tenantId),
          payload,
        })
        .then((r) => r.json<{ id: string }>());

      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/trunks/${created.id}/reveal`,
        payload: {},
      });

      expect(response.statusCode).toBe(401);
      expect(bus.published).toHaveLength(0);
    });

    it('409s revealing an ip-mode trunk with no credential', async () => {
      const tenantId = crypto.randomUUID();
      h.resellers.resellerIds[tenantId] = 'reseller-a';
      const created = await app
        .inject({
          method: 'POST',
          url: `/v1/tenants/${tenantId}/trunks`,
          headers: actorHeaders(tenantId),
          payload: { ...payload, authMode: 'ip', username: undefined, secret: undefined },
        })
        .then((r) => r.json<{ id: string }>());

      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/trunks/${created.id}/reveal`,
        headers: actorHeaders(tenantId),
        payload: {},
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'trunk_has_no_credential' });
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
