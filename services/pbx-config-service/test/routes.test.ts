import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@cuc/api-contracts';
import type { Bus } from '@cuc/events';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { registerExtensionRoutes } from '../src/routes/extension.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());
const TEST_INTERNAL_SECRET = 'test-internal-header-secret';

/**
 * Records every envelope handed to `publish` rather than opening a real NATS
 * connection — HTTP route behaviour is what this file tests, and
 * `publishAuditEvent` (`@cuc/audit`, S1-07) already has its own coverage of
 * actually talking to a `Bus`. `extension.repo.test.ts` and
 * `domain.consumer.test.ts` are where a real bus matters.
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

describe.skipIf(skipReason !== undefined)('pbx-config-service HTTP routes', () => {
  let h: Harness;
  let bus: ReturnType<typeof fakeBus>;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    bus = fakeBus();
    app = await createServer({
      serviceName: 'pbx-config-service',
      logger: h.logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: TEST_INTERNAL_SECRET },
    });
    registerExtensionRoutes(app, h.extensions, bus);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
    h.domains.realms = {};
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

  describe('POST /v1/tenants/:tenantId/extensions', () => {
    it('creates an extension and never returns the SIP secret', async () => {
      const tenantId = crypto.randomUUID();
      h.domains.realms[tenantId] = 'tenant-a.platform.test';

      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/extensions`,
        headers: actorHeaders(tenantId),
        payload: {
          number: '101',
          displayName: 'Front Desk',
          emergencyLocationId: (
            await h.emergencyLocations.create(
              { tenantId },
              {
                label: 'Test Location',
                addressLine1: '123 Main St',
                city: 'Springfield',
                state: 'IL',
                postalCode: '62701',
                country: 'US',
              },
            )
          ).id,
        },
      });

      expect(response.statusCode).toBe(201);
      const body: Record<string, unknown> = response.json();
      expect(body).toMatchObject({ number: '101', displayName: 'Front Desk' });
      expect(JSON.stringify(body)).not.toMatch(/secret|password|ha1/i);
    });

    it('409s a duplicate extension number', async () => {
      const tenantId = crypto.randomUUID();
      h.domains.realms[tenantId] = 'tenant-a.platform.test';
      await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/extensions`,
        headers: actorHeaders(tenantId),
        payload: {
          number: '101',
          displayName: 'A',
          emergencyLocationId: (
            await h.emergencyLocations.create(
              { tenantId },
              {
                label: 'Test Location',
                addressLine1: '123 Main St',
                city: 'Springfield',
                state: 'IL',
                postalCode: '62701',
                country: 'US',
              },
            )
          ).id,
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/extensions`,
        headers: actorHeaders(tenantId),
        payload: {
          number: '101',
          displayName: 'B',
          emergencyLocationId: (
            await h.emergencyLocations.create(
              { tenantId },
              {
                label: 'Test Location',
                addressLine1: '123 Main St',
                city: 'Springfield',
                state: 'IL',
                postalCode: '62701',
                country: 'US',
              },
            )
          ).id,
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'extension_number_taken' });
    });

    it('400s a malformed number', async () => {
      const tenantId = crypto.randomUUID();
      h.domains.realms[tenantId] = 'tenant-a.platform.test';

      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/extensions`,
        headers: actorHeaders(tenantId),
        payload: {
          number: 'not-a-number',
          displayName: 'A',
          emergencyLocationId: (
            await h.emergencyLocations.create(
              { tenantId },
              {
                label: 'Test Location',
                addressLine1: '123 Main St',
                city: 'Springfield',
                state: 'IL',
                postalCode: '62701',
                country: 'US',
              },
            )
          ).id,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('409s when the tenant has no primary SIP domain yet', async () => {
      const tenantId = crypto.randomUUID();

      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/extensions`,
        headers: actorHeaders(tenantId),
        payload: {
          number: '101',
          displayName: 'A',
          emergencyLocationId: (
            await h.emergencyLocations.create(
              { tenantId },
              {
                label: 'Test Location',
                addressLine1: '123 Main St',
                city: 'Springfield',
                state: 'IL',
                postalCode: '62701',
                country: 'US',
              },
            )
          ).id,
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'tenant_domain_not_found' });
    });
  });

  describe('GET /v1/tenants/:tenantId/extensions', () => {
    it('lists extensions for the tenant', async () => {
      const tenantId = crypto.randomUUID();
      h.domains.realms[tenantId] = 'tenant-a.platform.test';
      await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/extensions`,
        headers: actorHeaders(tenantId),
        payload: {
          number: '101',
          displayName: 'A',
          emergencyLocationId: (
            await h.emergencyLocations.create(
              { tenantId },
              {
                label: 'Test Location',
                addressLine1: '123 Main St',
                city: 'Springfield',
                state: 'IL',
                postalCode: '62701',
                country: 'US',
              },
            )
          ).id,
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: `/v1/tenants/${tenantId}/extensions`,
        headers: actorHeaders(tenantId),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ rows: [{ number: '101' }] });
    });
  });

  describe('PATCH /v1/tenants/:tenantId/extensions/:id', () => {
    it('updates display fields', async () => {
      const tenantId = crypto.randomUUID();
      h.domains.realms[tenantId] = 'tenant-a.platform.test';
      const created = await app
        .inject({
          method: 'POST',
          url: `/v1/tenants/${tenantId}/extensions`,
          headers: actorHeaders(tenantId),
          payload: {
            number: '101',
            displayName: 'A',
            emergencyLocationId: (
              await h.emergencyLocations.create(
                { tenantId },
                {
                  label: 'Test Location',
                  addressLine1: '123 Main St',
                  city: 'Springfield',
                  state: 'IL',
                  postalCode: '62701',
                  country: 'US',
                },
              )
            ).id,
          },
        })
        .then((r) => r.json<{ id: string }>());

      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}/extensions/${created.id}`,
        headers: actorHeaders(tenantId),
        payload: { displayName: 'B', voicemailEnabled: true },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ displayName: 'B', voicemailEnabled: true });
    });

    it('404s an unknown extension', async () => {
      const tenantId = crypto.randomUUID();

      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}/extensions/${crypto.randomUUID()}`,
        headers: actorHeaders(tenantId),
        payload: { displayName: 'B' },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('DELETE /v1/tenants/:tenantId/extensions/:id', () => {
    it('deletes an extension', async () => {
      const tenantId = crypto.randomUUID();
      h.domains.realms[tenantId] = 'tenant-a.platform.test';
      const created = await app
        .inject({
          method: 'POST',
          url: `/v1/tenants/${tenantId}/extensions`,
          headers: actorHeaders(tenantId),
          payload: {
            number: '101',
            displayName: 'A',
            emergencyLocationId: (
              await h.emergencyLocations.create(
                { tenantId },
                {
                  label: 'Test Location',
                  addressLine1: '123 Main St',
                  city: 'Springfield',
                  state: 'IL',
                  postalCode: '62701',
                  country: 'US',
                },
              )
            ).id,
          },
        })
        .then((r) => r.json<{ id: string }>());

      const response = await app.inject({
        method: 'DELETE',
        url: `/v1/tenants/${tenantId}/extensions/${created.id}`,
        headers: actorHeaders(tenantId),
      });

      expect(response.statusCode).toBe(204);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/v1/tenants/${tenantId}/extensions/${created.id}`,
            headers: actorHeaders(tenantId),
          })
        ).statusCode,
      ).toBe(404);
    });
  });

  describe('POST /v1/tenants/:tenantId/extensions/:id/reset-password', () => {
    async function seedExtension(tenantId: string): Promise<{ id: string }> {
      h.domains.realms[tenantId] = 'tenant-a.platform.test';
      return app
        .inject({
          method: 'POST',
          url: `/v1/tenants/${tenantId}/extensions`,
          headers: actorHeaders(tenantId),
          payload: {
            number: '101',
            displayName: 'A',
            emergencyLocationId: (
              await h.emergencyLocations.create(
                { tenantId },
                {
                  label: 'Test Location',
                  addressLine1: '123 Main St',
                  city: 'Springfield',
                  state: 'IL',
                  postalCode: '62701',
                  country: 'US',
                },
              )
            ).id,
          },
        })
        .then((r) => r.json<{ id: string }>());
    }

    it('returns a new password, which is what a later reveal returns, and publishes an audit event', async () => {
      const tenantId = crypto.randomUUID();
      const created = await seedExtension(tenantId);
      const first = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/extensions/${created.id}/reveal`,
        headers: actorHeaders(tenantId),
        payload: {},
      });
      bus.published.length = 0;

      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/extensions/${created.id}/reset-password`,
        headers: actorHeaders(tenantId),
        payload: { reason: 'phone was lost' },
      });

      expect(response.statusCode, response.body).toBe(200);
      const body: { username: string; password: string; realm: string } = response.json();
      expect(body.username).toBe('101');
      expect(body.realm).toBe('tenant-a.platform.test');
      expect(body.password).not.toBe(first.json<{ password: string }>().password);

      const later = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/extensions/${created.id}/reveal`,
        headers: actorHeaders(tenantId),
        payload: {},
      });
      expect(later.json<{ password: string }>().password).toBe(body.password);

      expect(bus.published[0]).toMatchObject({
        type: 'audit.event.recorded',
        actor: { type: 'user', id: 'user-1', orgId: tenantId },
        data: {
          action: 'extension.credential.reset',
          resource: created.id,
          dataClass: 'secret',
          targetOrgId: tenantId,
          reason: 'phone was lost',
        },
      });
    });

    it('rejects a reset with no identified actor, and changes nothing', async () => {
      const tenantId = crypto.randomUUID();
      const created = await seedExtension(tenantId);
      const before = await h.extensions.reveal({ tenantId }, created.id);
      bus.published.length = 0;

      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/extensions/${created.id}/reset-password`,
        payload: {},
      });

      expect(response.statusCode).toBe(401);
      expect(bus.published).toHaveLength(0);
      expect((await h.extensions.reveal({ tenantId }, created.id)).password).toBe(before.password);
    });

    it('404s resetting a nonexistent extension, without publishing an audit event', async () => {
      const tenantId = crypto.randomUUID();

      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/extensions/${crypto.randomUUID()}/reset-password`,
        headers: actorHeaders(tenantId),
        payload: {},
      });

      expect(response.statusCode).toBe(404);
      expect(bus.published).toHaveLength(0);
    });
  });

  describe('POST /v1/tenants/:tenantId/extensions/:id/reveal', () => {
    it('returns the plaintext credential and publishes an audit event', async () => {
      const tenantId = crypto.randomUUID();
      h.domains.realms[tenantId] = 'tenant-a.platform.test';
      const created = await app
        .inject({
          method: 'POST',
          url: `/v1/tenants/${tenantId}/extensions`,
          headers: actorHeaders(tenantId),
          payload: {
            number: '101',
            displayName: 'A',
            emergencyLocationId: (
              await h.emergencyLocations.create(
                { tenantId },
                {
                  label: 'Test Location',
                  addressLine1: '123 Main St',
                  city: 'Springfield',
                  state: 'IL',
                  postalCode: '62701',
                  country: 'US',
                },
              )
            ).id,
          },
        })
        .then((r) => r.json<{ id: string }>());

      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/extensions/${created.id}/reveal`,
        headers: actorHeaders(tenantId),
        payload: { reason: 'porting to a new desk phone' },
      });

      expect(response.statusCode).toBe(200);
      const body: { username: string; password: string; realm: string } = response.json();
      expect(body.username).toBe('101');
      expect(body.realm).toBe('tenant-a.platform.test');
      expect(body.password.length).toBeGreaterThan(0);

      expect(bus.published).toHaveLength(1);
      expect(bus.published[0]).toMatchObject({
        type: 'audit.event.recorded',
        actor: { type: 'user', id: 'user-1', orgId: tenantId },
        data: {
          action: 'extension.credential.revealed',
          resource: created.id,
          dataClass: 'secret',
          targetOrgId: tenantId,
          reason: 'porting to a new desk phone',
        },
      });
    });

    it('rejects a reveal with no identified actor', async () => {
      const tenantId = crypto.randomUUID();
      h.domains.realms[tenantId] = 'tenant-a.platform.test';
      const created = await app
        .inject({
          method: 'POST',
          url: `/v1/tenants/${tenantId}/extensions`,
          headers: actorHeaders(tenantId),
          payload: {
            number: '101',
            displayName: 'A',
            emergencyLocationId: (
              await h.emergencyLocations.create(
                { tenantId },
                {
                  label: 'Test Location',
                  addressLine1: '123 Main St',
                  city: 'Springfield',
                  state: 'IL',
                  postalCode: '62701',
                  country: 'US',
                },
              )
            ).id,
          },
        })
        .then((r) => r.json<{ id: string }>());

      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/extensions/${created.id}/reveal`,
        payload: {},
      });

      expect(response.statusCode).toBe(401);
      expect(bus.published).toHaveLength(0);
    });

    it('404s revealing a nonexistent extension, without publishing an audit event', async () => {
      const tenantId = crypto.randomUUID();

      const response = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/extensions/${crypto.randomUUID()}/reveal`,
        headers: actorHeaders(tenantId),
        payload: {},
      });

      expect(response.statusCode).toBe(404);
      expect(bus.published).toHaveLength(0);
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
