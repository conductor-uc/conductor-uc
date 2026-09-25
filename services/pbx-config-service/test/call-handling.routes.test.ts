import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@cuc/api-contracts';
import type { Bus } from '@cuc/events';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { registerCallHandlingInternalRoutes } from '../src/routes/call-handling-internal.routes.js';
import { registerCallHandlingRoutes } from '../src/routes/call-handling.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());
const TEST_INTERNAL_SECRET = 'test-internal-header-secret';
const SERVICE_TOKEN = 'test-service-token';

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

describe.skipIf(skipReason !== undefined)('call handling HTTP routes', () => {
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
    registerCallHandlingRoutes(app, h.callHandling, bus);
    registerCallHandlingInternalRoutes(app, h.callHandling, SERVICE_TOKEN);
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

  async function makeExtension(tenantId: string, number: string) {
    h.domains.realms[tenantId] = `${tenantId}.platform.test`;
    const location = await h.emergencyLocations.create(
      { tenantId },
      {
        label: 'HQ',
        addressLine1: '1 Main St',
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
        country: 'US',
      },
    );
    return h.extensions.create(
      { tenantId },
      { number, displayName: `Ext ${number}`, emergencyLocationId: location.id },
    );
  }

  const url = (tenantId: string, extensionId: string) =>
    `/v1/tenants/${tenantId}/extensions/${extensionId}/call-handling`;

  it('declares extension.manage and a data class on both routes (CLAUDE.md rule 3)', () => {
    const routes = app.registeredRoutes.filter(
      (r) => r.url.startsWith('/v1/') && r.url.endsWith('/call-handling') && r.method !== 'HEAD',
    );
    expect(routes.map((r) => r.method).sort()).toEqual(['GET', 'PUT']);
    for (const route of routes) {
      expect(route.permission).toBe('extension.manage');
      expect(route.dataClass).toBe('config');
    }
  });

  it('GET returns the all-off default for an extension with nothing configured', async () => {
    const tenantId = crypto.randomUUID();
    const a = await makeExtension(tenantId, '101');
    const res = await app.inject({
      method: 'GET',
      url: url(tenantId, a.id),
      headers: actorHeaders(tenantId),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      dnd: false,
      dndAction: 'voicemail',
      forwardAlways: null,
      forwardBusy: null,
      forwardNoAnswer: null,
      noAnswerSeconds: 20,
      forwardUnreachable: null,
      simultaneousRing: [],
    });
  });

  it('PUT saves, GET reads it back, and the change is audited and evented', async () => {
    const tenantId = crypto.randomUUID();
    const a = await makeExtension(tenantId, '101');
    const b = await makeExtension(tenantId, '102');
    const payload = {
      dnd: false,
      dndAction: 'voicemail',
      forwardAlways: null,
      forwardBusy: { type: 'extension', extensionId: b.id },
      forwardNoAnswer: { type: 'external', e164: '+14155552671' },
      noAnswerSeconds: 30,
      forwardUnreachable: { type: 'voicemail' },
      simultaneousRing: [{ type: 'external', e164: '+14155552672' }],
    };
    const put = await app.inject({
      method: 'PUT',
      url: url(tenantId, a.id),
      headers: actorHeaders(tenantId),
      payload,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual(payload);

    const got = await app.inject({
      method: 'GET',
      url: url(tenantId, a.id),
      headers: actorHeaders(tenantId),
    });
    expect(got.json()).toEqual(payload);

    expect(bus.published).toHaveLength(1);
    expect(bus.published[0]).toMatchObject({
      type: 'audit.event.recorded',
      data: {
        action: 'extension.call_handling.updated',
        resource: a.id,
        dataClass: 'config',
        targetOrgId: tenantId,
      },
    });
    const outbox = await h.db.kysely.selectFrom('outbox').select('type').execute();
    expect(outbox.map((o) => o.type)).toContain('pbx.call_handling.updated');
  });

  it.each([
    ['a non-E.164 external number', { forwardAlways: { type: 'external', e164: '415-555-2671' } }],
    [
      'too many simultaneous-ring destinations',
      {
        simultaneousRing: Array.from({ length: 6 }, (_, i) => ({
          type: 'external',
          e164: `+1415555260${String(i)}`,
        })),
      },
    ],
    [
      'a destination extension that does not exist',
      { forwardBusy: { type: 'extension', extensionId: 'missing' } },
    ],
    ['no-answer seconds out of range', { noAnswerSeconds: 3 }],
    ['voicemail in the ring list', { simultaneousRing: [{ type: 'voicemail' }] }],
  ])('PUT rejects %s with 400 and saves nothing', async (_name, payload) => {
    const tenantId = crypto.randomUUID();
    const a = await makeExtension(tenantId, '101');
    const res = await app.inject({
      method: 'PUT',
      url: url(tenantId, a.id),
      headers: actorHeaders(tenantId),
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(await h.db.kysely.selectFrom('extension_call_handling').selectAll().execute()).toEqual(
      [],
    );
    expect(bus.published).toHaveLength(0);
  });

  it('PUT rejects forwarding to itself and a forward-always loop', async () => {
    const tenantId = crypto.randomUUID();
    const a = await makeExtension(tenantId, '101');
    const b = await makeExtension(tenantId, '102');
    const self = await app.inject({
      method: 'PUT',
      url: url(tenantId, a.id),
      headers: actorHeaders(tenantId),
      payload: { forwardAlways: { type: 'extension', extensionId: a.id } },
    });
    expect(self.statusCode).toBe(400);

    await app.inject({
      method: 'PUT',
      url: url(tenantId, b.id),
      headers: actorHeaders(tenantId),
      payload: { forwardAlways: { type: 'extension', extensionId: a.id } },
    });
    const loop = await app.inject({
      method: 'PUT',
      url: url(tenantId, a.id),
      headers: actorHeaders(tenantId),
      payload: { forwardAlways: { type: 'extension', extensionId: b.id } },
    });
    expect(loop.statusCode).toBe(400);
    expect(loop.json<{ detail: string }>().detail).toMatch(/loop/);
  });

  it("another tenant's extension id is a 404 for GET and PUT, and cannot be written", async () => {
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();
    const a = await makeExtension(tenantA, '101');
    await makeExtension(tenantB, '101');

    const get = await app.inject({
      method: 'GET',
      url: url(tenantB, a.id),
      headers: actorHeaders(tenantB),
    });
    expect(get.statusCode).toBe(404);
    const put = await app.inject({
      method: 'PUT',
      url: url(tenantB, a.id),
      headers: actorHeaders(tenantB),
      payload: { dnd: true },
    });
    expect(put.statusCode).toBe(404);
    expect(await h.db.kysely.selectFrom('extension_call_handling').selectAll().execute()).toEqual(
      [],
    );
    expect(bus.published).toHaveLength(0);
  });

  describe('internal routes (telephony-config)', () => {
    const auth = { authorization: `Bearer ${SERVICE_TOKEN}` };

    it('require the service token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/t/extensions/x/call-handling`,
      });
      expect(res.statusCode).toBe(401);
      const list = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/t/call-handling`,
        headers: { authorization: 'Bearer wrong' },
      });
      expect(list.statusCode).toBe(401);
    });

    it('serve one extension (404 when unconfigured) and a tenant list, scoped to the tenant', async () => {
      const tenantA = crypto.randomUUID();
      const tenantB = crypto.randomUUID();
      const a = await makeExtension(tenantA, '101');
      const b = await makeExtension(tenantB, '101');
      const one = `/internal/v1/tenants/${tenantA}/extensions/${a.id}/call-handling`;

      expect((await app.inject({ method: 'GET', url: one, headers: auth })).statusCode).toBe(404);

      await h.callHandling.put({ tenantId: tenantA }, a.id, { dnd: true });
      await h.callHandling.put({ tenantId: tenantB }, b.id, { dnd: true, dndAction: 'busy' });

      const got = await app.inject({ method: 'GET', url: one, headers: auth });
      expect(got.json()).toMatchObject({ dnd: true, dndAction: 'voicemail' });

      const wrongTenant = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenantB}/extensions/${a.id}/call-handling`,
        headers: auth,
      });
      expect(wrongTenant.statusCode).toBe(404);

      const list = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenantA}/call-handling`,
        headers: auth,
      });
      expect(
        list.json<{ rows: { extensionId: string }[] }>().rows.map((r) => r.extensionId),
      ).toEqual([a.id]);
    });
  });
});
