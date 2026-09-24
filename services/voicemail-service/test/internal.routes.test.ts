import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';
import { createServer, type Server } from '@cuc/http';

import { registerInternalRoutes } from '../src/routes/internal.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());
const TOKEN = 'test-internal-service-token';

describe.skipIf(skipReason !== undefined)('voicemail-service internal routes (S2-16)', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({ serviceName: 'voicemail-service', logger: h.logger });
    registerInternalRoutes(app, h.mailboxes, h.messages, TOKEN, h.storage);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
  });

  function authHeader() {
    return { authorization: `Bearer ${TOKEN}` };
  }

  it('401s without a valid token', async () => {
    const tenantId = crypto.randomUUID();
    const response = await app.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${tenantId}/voicemail/mailboxes/by-extension/${crypto.randomUUID()}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('finds a mailbox by extension id', async () => {
    const tenantId = crypto.randomUUID();
    const extensionId = crypto.randomUUID();
    const mailbox = await h.mailboxes.create({ tenantId }, { extensionId, pin: '1234' });

    const response = await app.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${tenantId}/voicemail/mailboxes/by-extension/${extensionId}`,
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: mailbox.id, extensionId });
  });

  it('404s an extension with no mailbox', async () => {
    const tenantId = crypto.randomUUID();
    const response = await app.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${tenantId}/voicemail/mailboxes/by-extension/${crypto.randomUUID()}`,
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(404);
  });

  it('verifies a PIN', async () => {
    const tenantId = crypto.randomUUID();
    const mailbox = await h.mailboxes.create(
      { tenantId },
      { extensionId: crypto.randomUUID(), pin: '4242' },
    );

    const valid = await app.inject({
      method: 'POST',
      url: `/internal/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}/verify-pin`,
      headers: authHeader(),
      payload: { pin: '4242' },
    });
    expect(valid.json()).toMatchObject({ valid: true });

    const invalid = await app.inject({
      method: 'POST',
      url: `/internal/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}/verify-pin`,
      headers: authHeader(),
      payload: { pin: '0000' },
    });
    expect(invalid.json()).toMatchObject({ valid: false });
  });

  it('creates, completes, lists, marks read, and deletes a message — the FS leave-message/retrieval round trip', async () => {
    const tenantId = crypto.randomUUID();
    const mailbox = await h.mailboxes.create(
      { tenantId },
      { extensionId: crypto.randomUUID(), pin: '1234' },
    );

    const created = await app.inject({
      method: 'POST',
      url: `/internal/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}/messages`,
      headers: authHeader(),
      payload: { callerIdNumber: '+15005550001' },
    });
    expect(created.statusCode).toBe(201);
    const { messageId, uploadUrl }: { messageId: string; uploadUrl: string; objectKey: string } =
      created.json();

    const uploaded = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'audio/wav' },
      body: 'spool bytes',
    });
    expect(uploaded.ok).toBe(true);

    const completed = await app.inject({
      method: 'POST',
      url: `/internal/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}/messages/${messageId}/complete`,
      headers: authHeader(),
      payload: { durationMs: 5000, sizeBytes: 4096 },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ status: 'ready', isRead: false });

    const list = await app.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}/messages`,
      headers: authHeader(),
    });
    expect(list.json()).toMatchObject({ rows: [{ id: messageId }] });

    const single = await app.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}/messages/${messageId}`,
      headers: authHeader(),
    });
    expect(single.statusCode).toBe(200);
    expect(single.json()).toMatchObject({ id: messageId, status: 'ready' });

    const markedRead = await app.inject({
      method: 'POST',
      url: `/internal/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}/messages/${messageId}/mark-read`,
      headers: authHeader(),
    });
    expect(markedRead.json()).toMatchObject({ isRead: true });

    const deleted = await app.inject({
      method: 'POST',
      url: `/internal/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}/messages/${messageId}/delete`,
      headers: authHeader(),
    });
    expect(deleted.statusCode).toBe(204);
  });

  it('fails a message', async () => {
    const tenantId = crypto.randomUUID();
    const mailbox = await h.mailboxes.create(
      { tenantId },
      { extensionId: crypto.randomUUID(), pin: '1234' },
    );
    const { message } = await h.messages.create({ tenantId }, mailbox.id, {});

    const response = await app.inject({
      method: 'POST',
      url: `/internal/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}/messages/${message.id}/fail`,
      headers: authHeader(),
    });
    expect(response.statusCode).toBe(204);
    expect((await h.messages.findById({ tenantId }, message.id))?.status).toBe('failed');
  });

  it('presigns and completes a greeting', async () => {
    const tenantId = crypto.randomUUID();
    const mailbox = await h.mailboxes.create(
      { tenantId },
      { extensionId: crypto.randomUUID(), pin: '1234' },
    );

    const presigned = await app.inject({
      method: 'POST',
      url: `/internal/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}/greeting/presign`,
      headers: authHeader(),
    });
    expect(presigned.statusCode).toBe(201);

    const completed = await app.inject({
      method: 'POST',
      url: `/internal/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}/greeting/complete`,
      headers: authHeader(),
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ greetingStatus: 'ready' });
  });
  it('exposes the email settings, unread count, and message details a notifier needs (S5-07)', async () => {
    const tenantId = crypto.randomUUID();
    const mailbox = await h.mailboxes.create(
      { tenantId },
      { extensionId: crypto.randomUUID(), pin: '1234' },
    );
    await h.mailboxes.updateEmailSettings({ tenantId }, mailbox.id, {
      notifyEmail: 'owner@example.test',
      attachAudio: true,
      afterEmail: 'mark_read',
    });
    const { message, uploadUrl } = await h.messages.create({ tenantId }, mailbox.id, {
      callerIdName: 'Pat',
      callerIdNumber: '+15005550002',
    });
    await fetch(uploadUrl, { method: 'PUT', body: 'wav-bytes' });
    await h.messages.complete({ tenantId }, message.id, { durationMs: 7000, sizeBytes: 9 });

    const box = await app.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}`,
      headers: authHeader(),
    });
    expect(box.json()).toMatchObject({
      notifyEmail: 'owner@example.test',
      emailAttachAudio: true,
      emailAfter: 'mark_read',
      unreadCount: 1,
    });

    const single = await app.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}/messages/${message.id}`,
      headers: authHeader(),
    });
    expect(single.json()).toMatchObject({
      callerIdName: 'Pat',
      callerIdNumber: '+15005550002',
      durationMs: 7000,
      sizeBytes: 9,
    });
  });

  it('serves the recording bytes, only with a token and only within its own tenant', async () => {
    const tenantId = crypto.randomUUID();
    const mailbox = await h.mailboxes.create(
      { tenantId },
      { extensionId: crypto.randomUUID(), pin: '1234' },
    );
    const { message, uploadUrl } = await h.messages.create({ tenantId }, mailbox.id, {});
    await fetch(uploadUrl, { method: 'PUT', body: 'wav-bytes' });
    const url = `/internal/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}/messages/${message.id}/audio`;

    // Still pending: not readable yet.
    expect((await app.inject({ method: 'GET', url, headers: authHeader() })).statusCode).toBe(404);
    await h.messages.complete({ tenantId }, message.id, { durationMs: 1, sizeBytes: 9 });

    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'GET', url, headers: authHeader() });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('wav-bytes');

    const other = crypto.randomUUID();
    const crossTenant = await app.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${other}/voicemail/mailboxes/${mailbox.id}/messages/${message.id}/audio`,
      headers: authHeader(),
    });
    expect(crossTenant.statusCode).toBe(404);
  });
});
