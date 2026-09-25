import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { registerMailboxRoutes } from '../src/routes/mailbox.routes.js';
import { resetSchema, startHarness, storeAudio, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());
const TEST_INTERNAL_SECRET = 'test-internal-header-secret';

describe.skipIf(skipReason !== undefined)('mailbox HTTP routes', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({
      serviceName: 'voicemail-service',
      logger: h.logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: TEST_INTERNAL_SECRET },
    });
    registerMailboxRoutes(app, h.mailboxes, h.messages, h.storage);
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

  it('every route declares permission and dataClass (CLAUDE.md rule 3)', () => {
    for (const route of app.registeredRoutes) {
      if (route.url.startsWith('/v1/')) {
        expect(route.permission, `${route.method} ${route.url}`).not.toBeNull();
        expect(route.dataClass, `${route.method} ${route.url}`).not.toBeNull();
      }
    }
  });

  it('creates, lists, gets, and deletes a mailbox', async () => {
    const tenantId = crypto.randomUUID();
    const extensionId = crypto.randomUUID();

    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/voicemail/mailboxes`,
      headers: actorHeaders(tenantId),
      payload: { extensionId, pin: '1234' },
    });
    expect(created.statusCode, JSON.stringify(created.json())).toBe(201);
    const mailbox: { id: string; unreadCount: number } = created.json();
    expect(mailbox.unreadCount).toBe(0);

    const list = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/voicemail/mailboxes`,
      headers: actorHeaders(tenantId),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ rows: [{ extensionId }] });

    const got = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}`,
      headers: actorHeaders(tenantId),
    });
    expect(got.statusCode).toBe(200);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}`,
      headers: actorHeaders(tenantId),
    });
    expect(deleted.statusCode).toBe(204);

    const afterDelete = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}`,
      headers: actorHeaders(tenantId),
    });
    expect(afterDelete.statusCode).toBe(404);
  });

  it('409s creating a second mailbox for the same extension', async () => {
    const tenantId = crypto.randomUUID();
    const extensionId = crypto.randomUUID();
    await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/voicemail/mailboxes`,
      headers: actorHeaders(tenantId),
      payload: { extensionId, pin: '1234' },
    });

    const second = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/voicemail/mailboxes`,
      headers: actorHeaders(tenantId),
      payload: { extensionId, pin: '5678' },
    });
    expect(second.statusCode).toBe(409);
  });

  it('400s creating a mailbox with a malformed PIN', async () => {
    const tenantId = crypto.randomUUID();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/voicemail/mailboxes`,
      headers: actorHeaders(tenantId),
      payload: { extensionId: crypto.randomUUID(), pin: 'abcd' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('resets a PIN via /reset-pin', async () => {
    const tenantId = crypto.randomUUID();
    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/voicemail/mailboxes`,
      headers: actorHeaders(tenantId),
      payload: { extensionId: crypto.randomUUID(), pin: '1234' },
    });
    const mailbox: { id: string } = created.json();

    const reset = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}/reset-pin`,
      headers: actorHeaders(tenantId),
      payload: { pin: '9999' },
    });
    expect(reset.statusCode).toBe(204);

    expect(await h.mailboxes.verifyPin({ tenantId }, mailbox.id, '9999')).toBe(true);
  });

  it('uploads and completes a greeting through the presign/complete actions', async () => {
    const tenantId = crypto.randomUUID();
    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/voicemail/mailboxes`,
      headers: actorHeaders(tenantId),
      payload: { extensionId: crypto.randomUUID(), pin: '1234' },
    });
    const mailbox: { id: string } = created.json();

    const presigned = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}/greeting/presign`,
      headers: actorHeaders(tenantId),
    });
    expect(presigned.statusCode).toBe(201);
    const { uploadUrl }: { uploadUrl: string; objectKey: string } = presigned.json();

    const uploaded = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'audio/wav' },
      body: 'greeting bytes',
    });
    expect(uploaded.ok).toBe(true);

    const completed = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}/greeting/complete`,
      headers: actorHeaders(tenantId),
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ greetingStatus: 'ready' });
  });

  it('lists ready messages and returns a playable presigned play-url, then deletes the message', async () => {
    const tenantId = crypto.randomUUID();
    const mailbox = await h.mailboxes.create(
      { tenantId },
      { extensionId: crypto.randomUUID(), pin: '1234' },
    );
    const { message } = await h.messages.create({ tenantId }, mailbox.id, {
      callerIdNumber: '+15005550001',
    });
    await storeAudio(h, tenantId, message.objectKey, 'wav bytes');
    await h.messages.complete({ tenantId }, message.id, { durationMs: 1000, sizeBytes: 9 });

    const list = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}/messages`,
      headers: actorHeaders(tenantId),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      rows: [{ id: message.id, callerIdNumber: '+15005550001' }],
    });

    const playUrl = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}/messages/${message.id}/play-url`,
      headers: actorHeaders(tenantId),
    });
    expect(playUrl.statusCode).toBe(200);
    const { url }: { url: string } = playUrl.json();
    const played = await fetch(url);
    expect(await played.text()).toBe('wav bytes');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}/messages/${message.id}`,
      headers: actorHeaders(tenantId),
    });
    expect(deleted.statusCode).toBe(204);
  });
  it('defaults to no email, then saves and returns the email settings (S5-07)', async () => {
    const tenantId = crypto.randomUUID();
    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/voicemail/mailboxes`,
      headers: actorHeaders(tenantId),
      payload: { extensionId: crypto.randomUUID(), pin: '1234' },
    });
    expect(created.json()).toMatchObject({
      notifyEmail: null,
      emailAttachAudio: false,
      emailAfter: 'keep',
    });
    const { id }: { id: string } = created.json();

    const saved = await app.inject({
      method: 'PUT',
      url: `/v1/tenants/${tenantId}/voicemail/mailboxes/${id}/email-settings`,
      headers: actorHeaders(tenantId),
      payload: { notifyEmail: ' Owner@Example.test ', attachAudio: true, afterEmail: 'mark_read' },
    });
    expect(saved.statusCode, JSON.stringify(saved.json())).toBe(200);
    expect(saved.json()).toMatchObject({
      notifyEmail: 'Owner@Example.test',
      emailAttachAudio: true,
      emailAfter: 'mark_read',
    });

    const got = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/voicemail/mailboxes/${id}`,
      headers: actorHeaders(tenantId),
    });
    expect(got.json()).toMatchObject({
      notifyEmail: 'Owner@Example.test',
      emailAfter: 'mark_read',
    });

    const cleared = await app.inject({
      method: 'PUT',
      url: `/v1/tenants/${tenantId}/voicemail/mailboxes/${id}/email-settings`,
      headers: actorHeaders(tenantId),
      payload: { notifyEmail: '', attachAudio: false, afterEmail: 'keep' },
    });
    expect(cleared.json()).toMatchObject({ notifyEmail: null });
  });

  it('400s malformed email settings', async () => {
    const tenantId = crypto.randomUUID();
    const mailbox = await h.mailboxes.create(
      { tenantId },
      { extensionId: crypto.randomUUID(), pin: '1234' },
    );
    const url = `/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}/email-settings`;
    const bad: unknown[] = [
      { notifyEmail: 'not-an-address', attachAudio: false, afterEmail: 'keep' },
      { notifyEmail: 'a@example.test, b@example.test', attachAudio: false, afterEmail: 'keep' },
      {
        notifyEmail: 'a@example.test\r\nBcc: x@example.test',
        attachAudio: false,
        afterEmail: 'keep',
      },
      { notifyEmail: 'a@example.test', attachAudio: false, afterEmail: 'delete' },
      { notifyEmail: 'a@example.test', attachAudio: false, afterEmail: 'archive' },
      { notifyEmail: 'a@example.test', afterEmail: 'keep' },
    ];
    for (const payload of bad) {
      const response = await app.inject({
        method: 'PUT',
        url,
        headers: actorHeaders(tenantId),
        payload: payload as object,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('404s settings for a mailbox in another tenant, and leaves it unchanged', async () => {
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();
    const mailbox = await h.mailboxes.create(
      { tenantId: tenantA },
      { extensionId: crypto.randomUUID(), pin: '1234' },
    );
    const response = await app.inject({
      method: 'PUT',
      url: `/v1/tenants/${tenantB}/voicemail/mailboxes/${mailbox.id}/email-settings`,
      headers: actorHeaders(tenantB),
      payload: { notifyEmail: 'x@example.test', attachAudio: true, afterEmail: 'keep' },
    });
    expect(response.statusCode).toBe(404);
    const after = await h.mailboxes.findById({ tenantId: tenantA }, mailbox.id);
    expect(after?.notifyEmail).toBeNull();
  });

  it('H1: a reseller cannot read or change voicemail settings, messages or play URLs', async () => {
    const tenantId = crypto.randomUUID();
    const mailbox = await h.mailboxes.create(
      { tenantId },
      { extensionId: crypto.randomUUID(), pin: '1234' },
    );
    const reseller = signInternalHeaders(TEST_INTERNAL_SECRET, {
      actorId: 'reseller-user',
      actorType: 'user',
      orgId: 'reseller-1',
      orgType: 'reseller',
      tenantId,
    });
    const base = `/v1/tenants/${tenantId}/voicemail/mailboxes`;
    const attempts: { method: 'GET' | 'PUT' | 'POST'; url: string; payload?: object }[] = [
      { method: 'GET', url: base },
      { method: 'GET', url: `${base}/${mailbox.id}` },
      { method: 'GET', url: `${base}/${mailbox.id}/messages` },
      {
        method: 'PUT',
        url: `${base}/${mailbox.id}/email-settings`,
        payload: { notifyEmail: 'spy@example.test', attachAudio: true, afterEmail: 'keep' },
      },
      { method: 'POST', url: `${base}/${mailbox.id}/reset-pin`, payload: { pin: '9999' } },
    ];
    for (const attempt of attempts) {
      const response = await app.inject({ ...attempt, headers: reseller });
      expect(response.statusCode, `${attempt.method} ${attempt.url}`).toBe(403);
      expect(response.json()).toMatchObject({ code: 'reseller_private_data_denied' });
    }
    expect((await h.mailboxes.findById({ tenantId }, mailbox.id))?.notifyEmail).toBeNull();
  });
});
