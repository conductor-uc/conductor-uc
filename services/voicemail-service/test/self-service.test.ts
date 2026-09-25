import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@cuc/api-contracts';
import type { Bus } from '@cuc/events';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { PbxClientError, type UserExtensionLookup } from '../src/pbx-client.js';
import { registerMailboxRoutes } from '../src/routes/mailbox.routes.js';
import { registerMeRoutes } from '../src/routes/me.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());
const SECRET = 'test-internal-header-secret';
const SELF = ['self.settings', 'self.voicemail', 'self.history'];

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

const held: Record<string, string[]> = {};
/** `${tenantId}:${userId}` to the extension linked to them: pbx-config-service's answer, set per test. */
const links = new Map<string, string>();
let pbxDown = false;
const userExtension: UserExtensionLookup = (tenantId, userId) => {
  if (pbxDown) return Promise.reject(new PbxClientError('down'));
  const extensionId = links.get(`${tenantId}:${userId}`);
  return Promise.resolve(extensionId === undefined ? undefined : { extensionId, number: '101' });
};

describe.skipIf(skipReason !== undefined)('end-user self-service in voicemail-service', () => {
  let h: Harness;
  let bus: ReturnType<typeof fakeBus>;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    bus = fakeBus();
    app = await createServer({
      serviceName: 'voicemail-service',
      logger: h.logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
      permissions: (actor, permission) =>
        Promise.resolve(held[actor.id]?.includes(permission) ?? false),
    });
    registerMailboxRoutes(app, h.mailboxes, h.messages, h.storage);
    registerMeRoutes(app, h.mailboxes, h.messages, h.storage, userExtension, bus);
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await h?.close();
  });
  afterEach(async () => {
    await resetSchema(h.db);
    bus.published.length = 0;
    links.clear();
    pbxDown = false;
    for (const key of Object.keys(held)) delete held[key];
  });

  function person(
    tenantId: string,
    userId: string,
    permissions: string[] = SELF,
    extra: { orgType?: 'tenant' | 'reseller' | 'master'; orgId?: string } = {},
  ) {
    held[userId] = permissions;
    return signInternalHeaders(SECRET, {
      actorId: userId,
      actorType: 'user',
      orgId: extra.orgId ?? tenantId,
      orgType: extra.orgType ?? 'tenant',
      ...(extra.orgType === undefined || extra.orgType === 'tenant' ? { tenantId } : {}),
    });
  }

  /** A mailbox for [userId] with one ready message. */
  async function mailboxFor(tenantId: string, userId: string, caller = '+15005550001') {
    const extensionId = crypto.randomUUID();
    links.set(`${tenantId}:${userId}`, extensionId);
    const mailbox = await h.mailboxes.create({ tenantId }, { extensionId, pin: '1234' });
    const { message, uploadUrl } = await h.messages.create({ tenantId }, mailbox.id, {
      callerIdNumber: caller,
    });
    await fetch(uploadUrl, { method: 'PUT', body: 'wav bytes' });
    await h.messages.complete({ tenantId }, message.id, { durationMs: 1000, sizeBytes: 9 });
    return { mailbox, message };
  }

  const me = (tenantId: string, path = '') => `/v1/tenants/${tenantId}/me/voicemail${path}`;
  const audits = () =>
    bus.published
      .filter((e) => e.type === 'audit.event.recorded')
      .map((e) => e.data as Record<string, unknown>);

  it('every self route is self.voicemail and private, so H1 walls off every reseller (CLAUDE.md rule 3)', () => {
    const routes = app.registeredRoutes.filter(
      (r) => r.url.includes('/me/') && r.method !== 'HEAD',
    );
    expect(routes.length).toBe(7);
    for (const route of routes) {
      expect(route.permission, `${route.method} ${route.url}`).toBe('self.voicemail');
      expect(route.dataClass, `${route.method} ${route.url}`).toBe('private');
    }
  });

  describe('reading my own', () => {
    it('shows my mailbox and only my messages', async () => {
      const tenantId = crypto.randomUUID();
      const a = await mailboxFor(tenantId, 'user-a', '+15005550001');
      await mailboxFor(tenantId, 'user-b', '+15005550002');

      const summary = await app.inject({
        method: 'GET',
        url: me(tenantId),
        headers: person(tenantId, 'user-a'),
      });
      expect(summary.statusCode).toBe(200);
      expect(summary.json()).toEqual({
        greetingStatus: 'none',
        unreadCount: 1,
        notifyEmail: null,
        emailAttachAudio: false,
        emailAfter: 'keep',
      });

      const list = await app.inject({
        method: 'GET',
        url: me(tenantId, '/messages'),
        headers: person(tenantId, 'user-a'),
      });
      expect(list.json<{ rows: { id: string; callerIdNumber: string }[] }>().rows).toEqual([
        expect.objectContaining({ id: a.message.id, callerIdNumber: '+15005550001' }),
      ]);
    });

    it('no parameter points it at someone else’s mailbox', async () => {
      const tenantId = crypto.randomUUID();
      const a = await mailboxFor(tenantId, 'user-a', '+15005550001');
      const b = await mailboxFor(tenantId, 'user-b', '+15005550002');
      const asA = person(tenantId, 'user-a');

      for (const query of [
        `?mailboxId=${b.mailbox.id}`,
        `?extensionId=${links.get(`${tenantId}:user-b`) ?? ''}`,
        '?userId=user-b',
        `?id=${b.mailbox.id}`,
      ]) {
        const list = await app.inject({
          method: 'GET',
          url: me(tenantId, '/messages') + query,
          headers: asA,
        });
        expect(list.statusCode, query).toBe(200);
        expect(
          list.json<{ rows: { id: string }[] }>().rows.map((r) => r.id),
          query,
        ).toEqual([a.message.id]);
      }
      // No path shape names a mailbox.
      for (const path of [`/mailboxes/${b.mailbox.id}/messages`, `/${b.mailbox.id}/messages`]) {
        const response = await app.inject({ method: 'GET', url: me(tenantId, path), headers: asA });
        expect(response.statusCode, path).toBe(404);
      }
    });

    it('user A cannot play, read or delete user B’s message by its id', async () => {
      const tenantId = crypto.randomUUID();
      await mailboxFor(tenantId, 'user-a');
      const b = await mailboxFor(tenantId, 'user-b');
      const asA = person(tenantId, 'user-a');

      const play = await app.inject({
        method: 'GET',
        url: me(tenantId, `/messages/${b.message.id}/play-url`),
        headers: asA,
      });
      const read = await app.inject({
        method: 'POST',
        url: me(tenantId, `/messages/${b.message.id}/read`),
        headers: asA,
      });
      const del = await app.inject({
        method: 'DELETE',
        url: me(tenantId, `/messages/${b.message.id}`),
        headers: asA,
      });
      for (const response of [play, read, del]) {
        expect(response.statusCode).toBe(404);
        // Exactly the answer for a message that does not exist.
        expect(response.json()).toMatchObject({
          detail: 'No message with that id in your mailbox.',
        });
      }
      const missing = await app.inject({
        method: 'GET',
        url: me(tenantId, `/messages/${crypto.randomUUID()}/play-url`),
        headers: asA,
      });
      expect(missing.json()).toMatchObject({ detail: 'No message with that id in your mailbox.' });

      const still = await h.messages.findById({ tenantId }, b.message.id);
      expect(still?.isRead).toBe(false);
      expect(audits()).toEqual([]);
    });

    it('another tenant’s message id is a 404 too', async () => {
      const t1 = crypto.randomUUID();
      const t2 = crypto.randomUUID();
      await mailboxFor(t1, 'user-a');
      const foreign = await mailboxFor(t2, 'user-z');
      for (const [method, path] of [
        ['GET', `/messages/${foreign.message.id}/play-url`],
        ['DELETE', `/messages/${foreign.message.id}`],
      ] as const) {
        const response = await app.inject({
          method,
          url: me(t1, path),
          headers: person(t1, 'user-a'),
        });
        expect(response.statusCode, path).toBe(404);
      }
      expect(await h.messages.findById({ tenantId: t2 }, foreign.message.id)).toBeDefined();
    });

    it('plays my own message with a presigned URL, and audits that I listened', async () => {
      const tenantId = crypto.randomUUID();
      const a = await mailboxFor(tenantId, 'user-a');
      const response = await app.inject({
        method: 'GET',
        url: me(tenantId, `/messages/${a.message.id}/play-url`),
        headers: person(tenantId, 'user-a'),
      });
      expect(response.statusCode).toBe(200);
      const { url } = response.json<{ url: string }>();
      const audio = await fetch(url);
      expect(await audio.text()).toBe('wav bytes');
      expect(audits()).toEqual([
        expect.objectContaining({
          action: 'voicemail.message.played',
          actorId: 'user-a',
          resource: a.message.id,
          targetOrgId: tenantId,
          dataClass: 'private',
        }),
      ]);
    });
  });

  describe('changing my own', () => {
    it('marks read and deletes my message, each audited', async () => {
      const tenantId = crypto.randomUUID();
      const a = await mailboxFor(tenantId, 'user-a');
      const asA = person(tenantId, 'user-a');

      const read = await app.inject({
        method: 'POST',
        url: me(tenantId, `/messages/${a.message.id}/read`),
        headers: asA,
      });
      expect(read.statusCode).toBe(204);
      expect((await h.messages.findById({ tenantId }, a.message.id))?.isRead).toBe(true);

      const del = await app.inject({
        method: 'DELETE',
        url: me(tenantId, `/messages/${a.message.id}`),
        headers: asA,
      });
      expect(del.statusCode).toBe(204);
      expect(await h.messages.findById({ tenantId }, a.message.id)).toBeUndefined();

      expect(audits().map((e) => e.action)).toEqual([
        'voicemail.message.read',
        'voicemail.message.deleted',
      ]);
    });

    it('resets only my PIN; the PIN is never in the audit record', async () => {
      const tenantId = crypto.randomUUID();
      const a = await mailboxFor(tenantId, 'user-a');
      const b = await mailboxFor(tenantId, 'user-b');

      const response = await app.inject({
        method: 'POST',
        url: me(tenantId, '/reset-pin'),
        headers: person(tenantId, 'user-a'),
        // Whatever else the body says, there is nowhere to name another mailbox.
        payload: { pin: '987654', mailboxId: b.mailbox.id },
      });
      expect(response.statusCode).toBe(204);
      expect(await h.mailboxes.verifyPin({ tenantId }, a.mailbox.id, '987654')).toBe(true);
      expect(await h.mailboxes.verifyPin({ tenantId }, b.mailbox.id, '1234')).toBe(true);
      expect(await h.mailboxes.verifyPin({ tenantId }, b.mailbox.id, '987654')).toBe(false);
      expect(audits()).toEqual([
        expect.objectContaining({ action: 'voicemail.pin.reset', resource: a.mailbox.id }),
      ]);
      expect(JSON.stringify(bus.published)).not.toContain('987654');
    });

    it('rejects a PIN that is not 4 to 8 digits', async () => {
      const tenantId = crypto.randomUUID();
      const a = await mailboxFor(tenantId, 'user-a');
      const response = await app.inject({
        method: 'POST',
        url: me(tenantId, '/reset-pin'),
        headers: person(tenantId, 'user-a'),
        payload: { pin: '12' },
      });
      expect(response.statusCode).toBe(400);
      expect(await h.mailboxes.verifyPin({ tenantId }, a.mailbox.id, '1234')).toBe(true);
      expect(audits()).toEqual([]);
    });

    it('sets my email settings only, and the address stays out of the audit record', async () => {
      const tenantId = crypto.randomUUID();
      const a = await mailboxFor(tenantId, 'user-a');
      const b = await mailboxFor(tenantId, 'user-b');

      const response = await app.inject({
        method: 'PUT',
        url: me(tenantId, '/email-settings'),
        headers: person(tenantId, 'user-a'),
        payload: {
          notifyEmail: 'me@example.com',
          attachAudio: true,
          afterEmail: 'mark_read',
          mailboxId: b.mailbox.id,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        notifyEmail: 'me@example.com',
        emailAttachAudio: true,
        emailAfter: 'mark_read',
      });
      expect((await h.mailboxes.findById({ tenantId }, a.mailbox.id))?.notifyEmail).toBe(
        'me@example.com',
      );
      expect((await h.mailboxes.findById({ tenantId }, b.mailbox.id))?.notifyEmail).toBeNull();
      expect(audits()).toEqual([
        expect.objectContaining({
          action: 'voicemail.email_settings.updated',
          resource: a.mailbox.id,
        }),
      ]);
      expect(JSON.stringify(bus.published)).not.toContain('me@example.com');
    });

    it('rejects a malformed address', async () => {
      const tenantId = crypto.randomUUID();
      await mailboxFor(tenantId, 'user-a');
      const response = await app.inject({
        method: 'PUT',
        url: me(tenantId, '/email-settings'),
        headers: person(tenantId, 'user-a'),
        payload: { notifyEmail: 'not an address', attachAudio: false, afterEmail: 'keep' },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('when there is nothing of mine to show', () => {
    it('a person with no linked extension gets a clear 404', async () => {
      const tenantId = crypto.randomUUID();
      await mailboxFor(tenantId, 'user-b');
      for (const [method, path] of [
        ['GET', ''],
        ['GET', '/messages'],
        ['POST', '/reset-pin'],
        ['PUT', '/email-settings'],
        ['DELETE', `/messages/${crypto.randomUUID()}`],
      ] as const) {
        const response = await app.inject({
          method,
          url: me(tenantId, path),
          headers: person(tenantId, 'user-a'),
          ...(path === '/reset-pin' ? { payload: { pin: '1234' } } : {}),
          ...(path === '/email-settings'
            ? { payload: { notifyEmail: null, attachAudio: false, afterEmail: 'keep' } }
            : {}),
        });
        expect(response.statusCode, `${method} ${path}`).toBe(404);
        expect(response.json(), `${method} ${path}`).toMatchObject({ code: 'no_linked_extension' });
      }
    });

    it('a person whose extension has no mailbox gets a different, clear 404', async () => {
      const tenantId = crypto.randomUUID();
      links.set(`${tenantId}:user-a`, crypto.randomUUID());
      const response = await app.inject({
        method: 'GET',
        url: me(tenantId),
        headers: person(tenantId, 'user-a'),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'no_mailbox' });
    });

    it('fails with 503, not with someone else’s data, when pbx-config-service is unreachable', async () => {
      const tenantId = crypto.randomUUID();
      await mailboxFor(tenantId, 'user-a');
      pbxDown = true;
      const response = await app.inject({
        method: 'GET',
        url: me(tenantId),
        headers: person(tenantId, 'user-a'),
      });
      expect(response.statusCode).toBe(503);
    });
  });

  describe('who can reach the self routes', () => {
    it.each(['reseller', 'master'] as const)(
      'a %s is refused: H1 for a reseller, no "me" for either',
      async (orgType) => {
        const tenantId = crypto.randomUUID();
        await mailboxFor(tenantId, 'user-a');
        // Holding every permission, and the same id as the linked person.
        const headers = person(tenantId, 'user-a', [...SELF, 'voicemail.access'], {
          orgType,
          orgId: crypto.randomUUID(),
        });
        const response = await app.inject({
          method: 'GET',
          url: me(tenantId, '/messages'),
          headers,
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({
          code: orgType === 'reseller' ? 'reseller_private_data_denied' : 'self_service_only',
        });
      },
    );

    it('a person of another tenant naming this one is refused at the tenant boundary (H2)', async () => {
      const t1 = crypto.randomUUID();
      const t2 = crypto.randomUUID();
      await mailboxFor(t1, 'user-a');
      const response = await app.inject({
        method: 'GET',
        url: me(t1),
        headers: person(t2, 'user-a'),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'tenant_boundary' });
    });

    it('a person without self.voicemail is refused', async () => {
      const tenantId = crypto.randomUUID();
      await mailboxFor(tenantId, 'user-a');
      const response = await app.inject({
        method: 'GET',
        url: me(tenantId),
        headers: person(tenantId, 'user-a', ['self.settings', 'self.history']),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'permission_denied' });
    });

    it('a self-service user cannot use the admin mailbox routes to reach anyone', async () => {
      const tenantId = crypto.randomUUID();
      const a = await mailboxFor(tenantId, 'user-a');
      const b = await mailboxFor(tenantId, 'user-b');
      const asA = person(tenantId, 'user-a');
      const base = `/v1/tenants/${tenantId}/voicemail/mailboxes`;
      for (const [method, path] of [
        ['GET', ''],
        ['GET', `/${b.mailbox.id}`],
        ['GET', `/${a.mailbox.id}`],
        ['GET', `/${b.mailbox.id}/messages`],
        ['GET', `/${b.mailbox.id}/messages/${b.message.id}/play-url`],
        ['DELETE', `/${b.mailbox.id}/messages/${b.message.id}`],
        ['POST', `/${b.mailbox.id}/reset-pin`],
        ['PUT', `/${b.mailbox.id}/email-settings`],
      ] as const) {
        const response = await app.inject({
          method,
          url: base + path,
          headers: asA,
          ...(method === 'POST' || method === 'PUT' ? { payload: {} } : {}),
        });
        expect(response.statusCode, `${method} ${path}`).toBe(403);
      }
      expect(await h.messages.findById({ tenantId }, b.message.id)).toBeDefined();
    });
  });
});
