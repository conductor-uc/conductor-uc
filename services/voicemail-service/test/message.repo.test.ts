import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { crossTenantProbe, databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';

import { MessageNotFoundError } from '../src/repo/message.repo.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());

describe.skipIf(skipReason !== undefined)('message repo', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
  });

  function ctxFor(tenantId: string) {
    return { tenantId };
  }

  async function seedMailbox(tenantId: string) {
    return h.mailboxes.create(ctxFor(tenantId), { extensionId: crypto.randomUUID(), pin: '1234' });
  }

  it('creates a pending message with a real, usable presigned upload URL', async () => {
    const tenantId = crypto.randomUUID();
    const mailbox = await seedMailbox(tenantId);

    const { message, uploadUrl } = await h.messages.create(ctxFor(tenantId), mailbox.id, {
      callerIdName: 'Alice',
      callerIdNumber: '+15005550001',
    });
    expect(message).toMatchObject({
      tenantId,
      mailboxId: mailbox.id,
      status: 'pending',
      callerIdName: 'Alice',
      callerIdNumber: '+15005550001',
      isRead: false,
    });

    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'audio/wav' },
      body: 'not really wav bytes, just proving the URL/bucket work',
    });
    expect(response.ok).toBe(true);
  });

  it('complete moves status to ready and enqueues voicemail.message.created and voicemail.mailbox.mwi_changed', async () => {
    const tenantId = crypto.randomUUID();
    const mailbox = await seedMailbox(tenantId);
    const { message } = await h.messages.create(ctxFor(tenantId), mailbox.id, {});

    const completed = await h.messages.complete(ctxFor(tenantId), message.id, {
      durationMs: 8000,
      sizeBytes: 32768,
    });
    expect(completed).toMatchObject({ status: 'ready', durationMs: 8000, sizeBytes: 32768 });

    const rows = await h.db.kysely
      .selectFrom('outbox')
      .select(['type', 'tenant_id as tenantId', 'payload'])
      .where('tenant_id', '=', tenantId)
      .execute();
    expect(rows).toContainEqual(
      expect.objectContaining({
        type: 'voicemail.message.created',
        tenantId,
        payload: { messageId: message.id, mailboxId: mailbox.id },
      }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        type: 'voicemail.mailbox.mwi_changed',
        tenantId,
        payload: { mailboxId: mailbox.id },
      }),
    );
  });

  it('fail moves status to failed', async () => {
    const tenantId = crypto.randomUUID();
    const mailbox = await seedMailbox(tenantId);
    const { message } = await h.messages.create(ctxFor(tenantId), mailbox.id, {});

    await h.messages.fail(ctxFor(tenantId), message.id);
    const found = await h.messages.findById(ctxFor(tenantId), message.id);
    expect(found?.status).toBe('failed');
  });

  it('404s completing a message that does not exist', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.messages.complete(ctxFor(tenantId), crypto.randomUUID(), { durationMs: 1, sizeBytes: 1 }),
    ).rejects.toThrow(MessageNotFoundError);
  });

  it('markRead enqueues voicemail.mailbox.mwi_changed only when it was previously unread', async () => {
    const tenantId = crypto.randomUUID();
    const mailbox = await seedMailbox(tenantId);
    const { message } = await h.messages.create(ctxFor(tenantId), mailbox.id, {});
    await h.messages.complete(ctxFor(tenantId), message.id, { durationMs: 1000, sizeBytes: 100 });

    await h.messages.markRead(ctxFor(tenantId), message.id);
    const afterFirst = await h.db.kysely
      .selectFrom('outbox')
      .select('type')
      .where('type', '=', 'voicemail.mailbox.mwi_changed')
      .execute();
    // One from `complete`, one from this first `markRead`.
    expect(afterFirst).toHaveLength(2);

    await h.messages.markRead(ctxFor(tenantId), message.id);
    const afterSecond = await h.db.kysely
      .selectFrom('outbox')
      .select('type')
      .where('type', '=', 'voicemail.mailbox.mwi_changed')
      .execute();
    // A second `markRead` on an already-read message is a no-op event-wise.
    expect(afterSecond).toHaveLength(2);
  });

  it('lists only ready messages, oldest first', async () => {
    const tenantId = crypto.randomUUID();
    const mailbox = await seedMailbox(tenantId);
    const { message: pending } = await h.messages.create(ctxFor(tenantId), mailbox.id, {});
    const { message: first } = await h.messages.create(ctxFor(tenantId), mailbox.id, {});
    await h.messages.complete(ctxFor(tenantId), first.id, { durationMs: 1, sizeBytes: 1 });
    const { message: second } = await h.messages.create(ctxFor(tenantId), mailbox.id, {});
    await h.messages.complete(ctxFor(tenantId), second.id, { durationMs: 1, sizeBytes: 1 });

    const ready = await h.messages.listReady(ctxFor(tenantId), mailbox.id);
    expect(ready.map((m) => m.id)).toEqual([first.id, second.id]);
    expect(ready.some((m) => m.id === pending.id)).toBe(false);
  });

  it('remove enqueues voicemail.mailbox.mwi_changed only when the message was unread', async () => {
    const tenantId = crypto.randomUUID();
    const mailbox = await seedMailbox(tenantId);
    const { message: unread } = await h.messages.create(ctxFor(tenantId), mailbox.id, {});
    await h.messages.complete(ctxFor(tenantId), unread.id, { durationMs: 1, sizeBytes: 1 });
    const { message: read } = await h.messages.create(ctxFor(tenantId), mailbox.id, {});
    await h.messages.complete(ctxFor(tenantId), read.id, { durationMs: 1, sizeBytes: 1 });
    await h.messages.markRead(ctxFor(tenantId), read.id);

    const before = await h.db.kysely
      .selectFrom('outbox')
      .select('type')
      .where('type', '=', 'voicemail.mailbox.mwi_changed')
      .execute();

    await h.messages.remove(ctxFor(tenantId), read.id);
    const afterReadRemoved = await h.db.kysely
      .selectFrom('outbox')
      .select('type')
      .where('type', '=', 'voicemail.mailbox.mwi_changed')
      .execute();
    expect(afterReadRemoved).toHaveLength(before.length);

    await h.messages.remove(ctxFor(tenantId), unread.id);
    const afterUnreadRemoved = await h.db.kysely
      .selectFrom('outbox')
      .select('type')
      .where('type', '=', 'voicemail.mailbox.mwi_changed')
      .execute();
    expect(afterUnreadRemoved).toHaveLength(before.length + 1);
  });

  it('404s removing a message that does not exist', async () => {
    const tenantId = crypto.randomUUID();
    await expect(h.messages.remove(ctxFor(tenantId), crypto.randomUUID())).rejects.toThrow(
      MessageNotFoundError,
    );
  });

  // 05 §2.4: every repository test suite includes a cross-tenant probe.
  crossTenantProbe({
    name: 'messages',
    seed: async (tenantId) => {
      const mailbox = await seedMailbox(tenantId);
      const { message } = await h.messages.create(ctxFor(tenantId), mailbox.id, {});
      await h.messages.complete(ctxFor(tenantId), message.id, { durationMs: 1, sizeBytes: 1 });
      return message.id;
    },
    // No tenant-wide "list all messages" method exists on the repo (messages
    // are always listed per-mailbox) — a direct query stands in, scoped the
    // same way `scoped(ctx)` would be.
    list: (tenantId) =>
      h.db.kysely
        .selectFrom('messages')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .execute(),
    findById: (tenantId, id) => h.messages.findById(ctxFor(tenantId), id),
    remove: (tenantId, id) =>
      h.messages
        .remove(ctxFor(tenantId), id)
        .then(() => 1)
        .catch((error: unknown) => {
          if (error instanceof MessageNotFoundError) return 0;
          throw error;
        }),
  });
});
