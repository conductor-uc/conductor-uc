import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@cuc/api-contracts';
import type { Bus } from '@cuc/events';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';
import {
  createRemotePermissionResolver,
  createServer,
  signInternalHeaders,
  type Server,
} from '@cuc/http';

import { ExtensionUserTakenError } from '../src/repo/extension.repo.js';
import { registerCallHandlingRoutes } from '../src/routes/call-handling.routes.js';
import { registerExtensionRoutes } from '../src/routes/extension.routes.js';
import { registerMeRoutes } from '../src/routes/me.routes.js';
import { registerUserExtensionInternalRoutes } from '../src/routes/user-extension-internal.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());
const SECRET = 'test-internal-header-secret';
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

/** What each fake person holds: `tenant_user` is the three self permissions, `tenant_admin` adds extension.manage. */
const SELF = ['self.settings', 'self.voicemail', 'self.history'];
const held: Record<string, string[]> = {};

const ALL_HANDLING = {
  dnd: true,
  dndAction: 'busy' as const,
  forwardAlways: null,
  forwardBusy: null,
  forwardNoAnswer: null,
  noAnswerSeconds: 20,
  forwardUnreachable: null,
  simultaneousRing: [],
};

describe.skipIf(skipReason !== undefined)('end-user self-service in pbx-config-service', () => {
  let h: Harness;
  let bus: ReturnType<typeof fakeBus>;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    bus = fakeBus();
    app = await createServer({
      serviceName: 'pbx-config-service',
      logger: h.logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
      // The same guard and resolver main.ts wires, with identity-service replaced
      // by `held` (and without implied reads, so the resolver's own G-10
      // implication is what lets a `.manage` holder read).
      permissions: createRemotePermissionResolver({
        baseUrl: 'http://identity-service',
        internalServiceToken: SERVICE_TOKEN,
        ttlMs: 0,
        fetchImpl: (input) => {
          const userId = /\/users\/([^/]+)\/permissions$/.exec(input as string)?.[1] ?? '';
          const permissions = held[decodeURIComponent(userId)] ?? [];
          return Promise.resolve(
            permissions.length === 0
              ? new Response(null, { status: 404 })
              : Response.json({ permissions }),
          );
        },
      }),
    });
    registerExtensionRoutes(app, h.extensions, bus);
    registerCallHandlingRoutes(app, h.callHandling, bus);
    registerMeRoutes(app, h.extensions, h.callHandling, bus);
    registerUserExtensionInternalRoutes(app, h.extensions, SERVICE_TOKEN);
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
    for (const key of Object.keys(held)) delete held[key];
  });

  /** A person of [tenantId] who holds [permissions], signed in as the gateway forwards them. */
  function person(
    tenantId: string,
    userId: string,
    permissions: string[] = SELF,
    extra: {
      orgType?: 'tenant' | 'reseller' | 'master';
      actorType?: 'user' | 'apikey';
      orgId?: string;
    } = {},
  ) {
    held[userId] = permissions;
    return signInternalHeaders(SECRET, {
      actorId: userId,
      actorType: extra.actorType ?? 'user',
      orgId: extra.orgId ?? tenantId,
      orgType: extra.orgType ?? 'tenant',
      ...(extra.orgType === undefined || extra.orgType === 'tenant' ? { tenantId } : {}),
    });
  }

  async function makeExtension(tenantId: string, number: string, userId?: string) {
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
      {
        number,
        displayName: `Ext ${number}`,
        emergencyLocationId: location.id,
        ...(userId === undefined ? {} : { userId }),
      },
    );
  }

  const me = (tenantId: string, path: string) => `/v1/tenants/${tenantId}/me/${path}`;

  it('declares self.settings and the config class on every route (CLAUDE.md rule 3)', () => {
    const routes = app.registeredRoutes.filter(
      (r) => r.url.includes('/me/') && r.method !== 'HEAD',
    );
    expect(routes.map((r) => `${r.method} ${r.url}`).sort()).toEqual([
      'GET /v1/tenants/:tenantId/me/call-handling',
      'GET /v1/tenants/:tenantId/me/directory',
      'GET /v1/tenants/:tenantId/me/extension',
      'PUT /v1/tenants/:tenantId/me/call-handling',
    ]);
    for (const route of routes) {
      expect(route.permission).toBe('self.settings');
      expect(route.dataClass).toBe('config');
    }
  });

  describe('the link between a person and an extension', () => {
    it('is unique per tenant: a person has at most one extension', async () => {
      const tenantId = crypto.randomUUID();
      await makeExtension(tenantId, '101', 'user-a');
      await expect(makeExtension(tenantId, '102', 'user-a')).rejects.toBeInstanceOf(
        ExtensionUserTakenError,
      );
      const other = await makeExtension(tenantId, '103');
      await expect(
        h.extensions.update({ tenantId }, other.id, { userId: 'user-a' }),
      ).rejects.toBeInstanceOf(ExtensionUserTakenError);
    });

    it('does not collide across tenants, or for extensions nobody owns', async () => {
      const t1 = crypto.randomUUID();
      const t2 = crypto.randomUUID();
      await makeExtension(t1, '101', 'user-a');
      await makeExtension(t2, '101', 'user-a');
      await makeExtension(t1, '102');
      await makeExtension(t1, '103');
      expect((await h.extensions.findByUserId({ tenantId: t2 }, 'user-a'))?.tenantId).toBe(t2);
    });

    it('an extension number clash is still reported as a number clash', async () => {
      const tenantId = crypto.randomUUID();
      await makeExtension(tenantId, '101', 'user-a');
      await expect(makeExtension(tenantId, '101', 'user-b')).rejects.toMatchObject({
        name: 'ExtensionNumberTakenError',
      });
    });

    it('findByUserId is tenant-scoped', async () => {
      const t1 = crypto.randomUUID();
      const t2 = crypto.randomUUID();
      await makeExtension(t1, '101', 'user-a');
      expect(await h.extensions.findByUserId({ tenantId: t2 }, 'user-a')).toBeUndefined();
    });

    it('a tenant admin links and unlinks through PATCH, and both are audited', async () => {
      const tenantId = crypto.randomUUID();
      const ext = await makeExtension(tenantId, '101');
      const admin = person(tenantId, 'admin-1', ['extension.manage']);

      const linked = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}/extensions/${ext.id}`,
        headers: admin,
        payload: { userId: 'user-a' },
      });
      expect(linked.statusCode).toBe(200);
      expect(linked.json()).toMatchObject({ userId: 'user-a' });
      const unlinked = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}/extensions/${ext.id}`,
        headers: admin,
        payload: { userId: null },
      });
      expect(unlinked.statusCode).toBe(200);

      const audits = bus.published.filter((e) => e.type === 'audit.event.recorded');
      expect(audits.map((e) => (e.data as { action: string }).action)).toEqual([
        'extension.user.linked',
        'extension.user.unlinked',
      ]);
      expect(audits[0]?.data).toMatchObject({
        actorId: 'admin-1',
        resource: ext.id,
        targetOrgId: tenantId,
      });
    });

    it('a second link for the same person is a 409 with a stable code', async () => {
      const tenantId = crypto.randomUUID();
      await makeExtension(tenantId, '101', 'user-a');
      const ext = await makeExtension(tenantId, '102');
      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}/extensions/${ext.id}`,
        headers: person(tenantId, 'admin-1', ['extension.manage']),
        payload: { userId: 'user-a' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'extension_user_taken' });
    });

    it('a reseller cannot link a person (they could then own a tenant mailbox), only unlink', async () => {
      const tenantId = crypto.randomUUID();
      const resellerId = crypto.randomUUID();
      const ext = await makeExtension(tenantId, '101', 'user-a');
      const reseller = person(tenantId, 'reseller-1', ['extension.manage'], {
        orgType: 'reseller',
        orgId: resellerId,
      });

      const link = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}/extensions/${ext.id}`,
        headers: reseller,
        payload: { userId: 'reseller-friend' },
      });
      expect(link.statusCode).toBe(403);
      expect(link.json()).toMatchObject({ code: 'reseller_cannot_link_user' });
      expect((await h.extensions.findById({ tenantId }, ext.id))?.userId).toBe('user-a');

      const create = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/extensions`,
        headers: reseller,
        payload: {
          number: '102',
          displayName: 'x',
          emergencyLocationId: ext.emergencyLocationId,
          userId: 'reseller-friend',
        },
      });
      expect(create.statusCode).toBe(403);

      const unlink = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}/extensions/${ext.id}`,
        headers: reseller,
        payload: { userId: null },
      });
      expect(unlink.statusCode).toBe(200);
    });

    it('an ordinary user cannot link themselves to an extension (extension.manage)', async () => {
      const tenantId = crypto.randomUUID();
      const ext = await makeExtension(tenantId, '101');
      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}/extensions/${ext.id}`,
        headers: person(tenantId, 'user-a'),
        payload: { userId: 'user-a' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'permission_denied' });
      expect((await h.extensions.findById({ tenantId }, ext.id))?.userId).toBeNull();
    });
  });

  describe('GET /me/extension', () => {
    it('returns the caller’s own extension, and nothing that identifies anyone else', async () => {
      const tenantId = crypto.randomUUID();
      const mine = await makeExtension(tenantId, '101', 'user-a');
      await makeExtension(tenantId, '102', 'user-b');

      const response = await app.inject({
        method: 'GET',
        url: me(tenantId, 'extension'),
        headers: person(tenantId, 'user-a'),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        id: mine.id,
        number: '101',
        displayName: 'Ext 101',
        callerIdName: null,
        callerIdNumber: null,
        voicemailEnabled: false,
      });
    });

    it('each person gets their own, and no parameter changes whose it is', async () => {
      const tenantId = crypto.randomUUID();
      const a = await makeExtension(tenantId, '101', 'user-a');
      const b = await makeExtension(tenantId, '102', 'user-b');
      const asA = person(tenantId, 'user-a');

      for (const query of [
        `?extensionId=${b.id}`,
        `?id=${b.id}`,
        '?userId=user-b',
        '?number=102',
        `?tenantId=${tenantId}&actorId=user-b`,
      ]) {
        const response = await app.inject({
          method: 'GET',
          url: me(tenantId, 'extension') + query,
          headers: asA,
        });
        expect(response.statusCode, query).toBe(200);
        expect(response.json<{ id: string }>().id, query).toBe(a.id);
      }
      // There is no path shape that names an extension either.
      for (const path of [`extension/${b.id}`, `extensions/${b.id}`, `${b.id}`]) {
        const response = await app.inject({ method: 'GET', url: me(tenantId, path), headers: asA });
        expect(response.statusCode, path).toBe(404);
      }
      // Forged identity headers do not verify.
      const forged = await app.inject({
        method: 'GET',
        url: me(tenantId, 'extension'),
        headers: { ...asA, 'x-internal-actor-id': 'user-b' },
      });
      expect(forged.statusCode).toBe(401);

      const asB = await app.inject({
        method: 'GET',
        url: me(tenantId, 'extension'),
        headers: person(tenantId, 'user-b'),
      });
      expect(asB.json<{ id: string }>().id).toBe(b.id);
    });

    it('a person with no linked extension gets a clear 404 with a stable code', async () => {
      const tenantId = crypto.randomUUID();
      await makeExtension(tenantId, '101', 'user-b');
      for (const path of ['extension', 'call-handling', 'directory']) {
        const response = await app.inject({
          method: 'GET',
          url: me(tenantId, path),
          headers: person(tenantId, 'user-a'),
        });
        expect(response.statusCode, path).toBe(404);
        expect(response.json(), path).toMatchObject({ code: 'no_linked_extension' });
      }
      const put = await app.inject({
        method: 'PUT',
        url: me(tenantId, 'call-handling'),
        headers: person(tenantId, 'user-a'),
        payload: ALL_HANDLING,
      });
      expect(put.statusCode).toBe(404);
      expect(put.json()).toMatchObject({ code: 'no_linked_extension' });
    });

    it('someone linked in another tenant has no extension here', async () => {
      const t1 = crypto.randomUUID();
      const t2 = crypto.randomUUID();
      await makeExtension(t1, '101', 'user-a');
      const response = await app.inject({
        method: 'GET',
        url: me(t2, 'extension'),
        headers: person(t2, 'user-a'),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'no_linked_extension' });
    });
  });

  describe('who can reach the self routes', () => {
    it('a person of another tenant naming this one is refused at the tenant boundary (H2)', async () => {
      const t1 = crypto.randomUUID();
      const t2 = crypto.randomUUID();
      await makeExtension(t1, '101', 'user-a');
      const response = await app.inject({
        method: 'GET',
        url: me(t1, 'extension'),
        headers: person(t2, 'user-a'),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'tenant_boundary' });
    });

    it.each(['reseller', 'master'] as const)(
      'a %s is refused, even holding the permission',
      async (orgType) => {
        const tenantId = crypto.randomUUID();
        await makeExtension(tenantId, '101', 'user-a');
        // The same id as the linked person, in the hope of being taken for them.
        const headers = person(tenantId, 'user-a', [...SELF, 'extension.manage'], {
          orgType,
          orgId: crypto.randomUUID(),
        });
        for (const [method, path] of [
          ['GET', 'extension'],
          ['GET', 'call-handling'],
          ['GET', 'directory'],
          ['PUT', 'call-handling'],
        ] as const) {
          const response = await app.inject({
            method,
            url: me(tenantId, path),
            headers,
            ...(method === 'PUT' ? { payload: ALL_HANDLING } : {}),
          });
          expect(response.statusCode, `${method} ${path}`).toBe(403);
          expect(response.json(), `${method} ${path}`).toMatchObject({ code: 'self_service_only' });
        }
      },
    );

    it('an API key is refused', async () => {
      const tenantId = crypto.randomUUID();
      await makeExtension(tenantId, '101', 'key-1');
      const response = await app.inject({
        method: 'GET',
        url: me(tenantId, 'extension'),
        headers: person(tenantId, 'key-1', SELF, { actorType: 'apikey' }),
      });
      expect(response.statusCode).toBe(403);
    });

    it('a person who holds no self.settings (a custom role, say) is refused', async () => {
      const tenantId = crypto.randomUUID();
      await makeExtension(tenantId, '101', 'user-a');
      const response = await app.inject({
        method: 'GET',
        url: me(tenantId, 'extension'),
        headers: person(tenantId, 'user-a', ['cdr.read']),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'permission_denied' });
    });

    it('a person holding extension.read sees extensions and call handling but changes nothing (G-10)', async () => {
      const tenantId = crypto.randomUUID();
      const ext = await makeExtension(tenantId, '101', 'user-a');
      const support = person(tenantId, 'support-1', ['extension.read']);
      for (const path of [
        'extensions',
        `extensions/${ext.id}`,
        `extensions/${ext.id}/call-handling`,
      ]) {
        const response = await app.inject({
          method: 'GET',
          url: `/v1/tenants/${tenantId}/${path}`,
          headers: support,
        });
        expect(response.statusCode, path).toBe(200);
      }
      for (const [method, path] of [
        ['PATCH', `extensions/${ext.id}`],
        ['PUT', `extensions/${ext.id}/call-handling`],
        ['POST', `extensions/${ext.id}/reveal`],
        ['DELETE', `extensions/${ext.id}`],
      ] as const) {
        const response = await app.inject({
          method,
          url: `/v1/tenants/${tenantId}/${path}`,
          headers: support,
          payload: method === 'PUT' ? ALL_HANDLING : method === 'PATCH' ? { userId: null } : {},
        });
        expect(response.statusCode, `${method} ${path}`).toBe(403);
      }
    });

    it('a person holding only extension.manage still lists extensions: .manage implies .read (G-10)', async () => {
      const tenantId = crypto.randomUUID();
      await makeExtension(tenantId, '101');
      const response = await app.inject({
        method: 'GET',
        url: `/v1/tenants/${tenantId}/extensions`,
        headers: person(tenantId, 'admin-1', ['extension.manage']),
      });
      expect(response.statusCode).toBe(200);
    });

    it('a self-service user cannot use the admin routes to read or change anyone', async () => {
      const tenantId = crypto.randomUUID();
      const mine = await makeExtension(tenantId, '101', 'user-a');
      const theirs = await makeExtension(tenantId, '102', 'user-b');
      const asA = person(tenantId, 'user-a');
      for (const [method, path] of [
        ['GET', 'extensions'],
        ['GET', `extensions/${theirs.id}`],
        ['GET', `extensions/${mine.id}`],
        ['GET', `extensions/${theirs.id}/call-handling`],
        ['PUT', `extensions/${theirs.id}/call-handling`],
        ['POST', `extensions/${mine.id}/reveal`],
        ['DELETE', `extensions/${mine.id}`],
      ] as const) {
        const response = await app.inject({
          method,
          url: `/v1/tenants/${tenantId}/${path}`,
          headers: asA,
          ...(method === 'PUT' || method === 'POST'
            ? { payload: method === 'PUT' ? ALL_HANDLING : {} }
            : {}),
        });
        expect(response.statusCode, `${method} ${path}`).toBe(403);
      }
    });
  });

  describe('PUT /me/call-handling', () => {
    it('changes only the caller’s own extension, and the change is audited and evented', async () => {
      const tenantId = crypto.randomUUID();
      const mine = await makeExtension(tenantId, '101', 'user-a');
      const theirs = await makeExtension(tenantId, '102', 'user-b');
      await h.callHandling.put({ tenantId }, theirs.id, { ...ALL_HANDLING, dnd: false });

      const put = await app.inject({
        method: 'PUT',
        url: me(tenantId, 'call-handling'),
        headers: person(tenantId, 'user-a'),
        // Whatever else the body says, there is nowhere to name another extension.
        payload: { ...ALL_HANDLING, extensionId: theirs.id, userId: 'user-b' },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toMatchObject({ dnd: true, dndAction: 'busy' });

      expect((await h.callHandling.get({ tenantId }, mine.id)).dnd).toBe(true);
      expect((await h.callHandling.get({ tenantId }, theirs.id)).dnd).toBe(false);

      const get = await app.inject({
        method: 'GET',
        url: me(tenantId, 'call-handling'),
        headers: person(tenantId, 'user-a'),
      });
      expect(get.json()).toMatchObject({ dnd: true });
      const other = await app.inject({
        method: 'GET',
        url: me(tenantId, 'call-handling'),
        headers: person(tenantId, 'user-b'),
      });
      expect(other.json()).toMatchObject({ dnd: false });

      const audits = bus.published.filter((e) => e.type === 'audit.event.recorded');
      expect(audits).toHaveLength(1);
      expect(audits[0]?.data).toMatchObject({
        actorId: 'user-a',
        actorType: 'user',
        action: 'extension.call_handling.updated',
        resource: mine.id,
        targetOrgId: tenantId,
        dataClass: 'config',
      });
      expect(bus.published.some((e) => e.type === 'pbx.call_handling.updated')).toBe(false);
    });

    it('shares the admin validation: loops, other tenants’ extensions and bad numbers are 400', async () => {
      const t1 = crypto.randomUUID();
      const t2 = crypto.randomUUID();
      const mine = await makeExtension(t1, '101', 'user-a');
      const foreign = await makeExtension(t2, '101');
      const asA = person(t1, 'user-a');

      const toSelf = await app.inject({
        method: 'PUT',
        url: me(t1, 'call-handling'),
        headers: asA,
        payload: {
          ...ALL_HANDLING,
          dnd: false,
          forwardAlways: { type: 'extension', extensionId: mine.id },
        },
      });
      expect(toSelf.statusCode).toBe(400);
      expect(toSelf.json()).toMatchObject({ code: 'invalid_call_handling' });

      const toForeign = await app.inject({
        method: 'PUT',
        url: me(t1, 'call-handling'),
        headers: asA,
        payload: {
          ...ALL_HANDLING,
          dnd: false,
          forwardBusy: { type: 'extension', extensionId: foreign.id },
        },
      });
      expect(toForeign.statusCode).toBe(400);

      const badNumber = await app.inject({
        method: 'PUT',
        url: me(t1, 'call-handling'),
        headers: asA,
        payload: { ...ALL_HANDLING, dnd: false, forwardAlways: { type: 'external', e164: 'nope' } },
      });
      expect(badNumber.statusCode).toBe(400);
      expect((await h.callHandling.get({ tenantId: t1 }, mine.id)).dnd).toBe(false);
    });
  });

  describe('GET /me/directory', () => {
    it('lists this tenant’s extensions by id, number and name only', async () => {
      const t1 = crypto.randomUUID();
      const t2 = crypto.randomUUID();
      const mine = await makeExtension(t1, '101', 'user-a');
      const other = await makeExtension(t1, '102', 'user-b');
      await makeExtension(t2, '103');

      const response = await app.inject({
        method: 'GET',
        url: me(t1, 'directory'),
        headers: person(t1, 'user-a'),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        rows: [
          { id: mine.id, number: '101', displayName: 'Ext 101' },
          { id: other.id, number: '102', displayName: 'Ext 102' },
        ],
      });
    });
  });

  describe('GET /internal/v1/tenants/:tenantId/users/:userId/extension', () => {
    const url = (tenantId: string, userId: string) =>
      `/internal/v1/tenants/${tenantId}/users/${userId}/extension`;
    const auth = { authorization: `Bearer ${SERVICE_TOKEN}` };

    it('needs the internal service token', async () => {
      const tenantId = crypto.randomUUID();
      await makeExtension(tenantId, '101', 'user-a');
      expect((await app.inject({ method: 'GET', url: url(tenantId, 'user-a') })).statusCode).toBe(
        401,
      );
      expect(
        (
          await app.inject({
            method: 'GET',
            url: url(tenantId, 'user-a'),
            headers: { authorization: 'Bearer wrong' },
          })
        ).statusCode,
      ).toBe(401);
    });

    it('answers with the person’s own extension, and 404 for nobody, or for another tenant', async () => {
      const t1 = crypto.randomUUID();
      const t2 = crypto.randomUUID();
      const mine = await makeExtension(t1, '101', 'user-a');
      const ok = await app.inject({ method: 'GET', url: url(t1, 'user-a'), headers: auth });
      expect(ok.json()).toEqual({ extensionId: mine.id, number: '101' });
      expect(
        (await app.inject({ method: 'GET', url: url(t1, 'user-x'), headers: auth })).statusCode,
      ).toBe(404);
      expect(
        (await app.inject({ method: 'GET', url: url(t2, 'user-a'), headers: auth })).statusCode,
      ).toBe(404);
    });
  });
});
