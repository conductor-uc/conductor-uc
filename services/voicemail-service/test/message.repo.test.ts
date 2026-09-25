import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { crossTenantProbe, databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';

import { MessageAlreadyReadyError, MessageNotFoundError } from '../src/repo/message.repo.js';
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

  it('creates a pending message under its mailbox’s object prefix', async () => {
    const tenantId = crypto.randomUUID();
    const mailbox = await seedMailbox(tenantId);

    const { message } = await h.messages.create(ctxFor(tenantId), mailbox.id, {
      callerIdName: 'Alice',
      callerIdNumber: '+15005550001',
    });
    expect(message).toMatchObject({
      tenantId,
      mailboxId: mailbox.id,
      status: 'pending',
      objectKey: `voicemail/${mailbox.id}/${message.id}.wav`,
      callerIdName: 'Alice',
      callerIdNumber: '+15005550001',
      sha256: null,
      failureReason: null,
      isRead: false,
    });
    expect(message.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
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

  it('fail moves status to failed with its reason, and leaves a ready message alone', async () => {
    const tenantId = crypto.randomUUID();
    const mailbox = await seedMailbox(tenantId);
    const { message } = await h.messages.create(ctxFor(tenantId), mailbox.id, {});

    await h.messages.fail(ctxFor(tenantId), message.id, 'empty_file');
    const found = await h.messages.findById(ctxFor(tenantId), message.id);
    expect(found).toMatchObject({ status: 'failed', failureReason: 'empty_file' });

    const { message: ready } = await h.messages.create(ctxFor(tenantId), mailbox.id, {});
    await h.messages.complete(ctxFor(tenantId), ready.id, { durationMs: 1, sizeBytes: 1 });
    await h.messages.fail(ctxFor(tenantId), ready.id, 'late');
    expect((await h.messages.findById(ctxFor(tenantId), ready.id))?.status).toBe('ready');

    await expect(
      h.messages.fail(ctxFor(tenantId), crypto.randomUUID(), 'empty_file'),
    ).rejects.toThrow(MessageNotFoundError);
  });

  it('complete stores the sha256, refuses a message that is already ready, and revives a failed one (S5-16)', async () => {
    const tenantId = crypto.randomUUID();
    const mailbox = await seedMailbox(tenantId);
    const { message } = await h.messages.create(ctxFor(tenantId), mailbox.id, {});
    const sha256 = 'a'.repeat(64);

    await h.messages.fail(ctxFor(tenantId), message.id, 'never_uploaded');
    const completed = await h.messages.complete(ctxFor(tenantId), message.id, {
      durationMs: null,
      sizeBytes: 44,
      sha256,
    });
    expect(completed).toMatchObject({ status: 'ready', sha256, failureReason: null });
    expect(await h.messages.findById(ctxFor(tenantId), message.id)).toMatchObject({
      status: 'ready',
      sha256,
      sizeBytes: 44,
      durationMs: null,
      failureReason: null,
    });

    await expect(
      h.messages.complete(ctxFor(tenantId), message.id, { durationMs: 1, sizeBytes: 1 }),
    ).rejects.toThrow(MessageAlreadyReadyError);
    // The retried complete emitted nothing more.
    const created = await h.db.kysely
      .selectFrom('outbox')
      .select('type')
      .where('type', '=', 'voicemail.message.created')
      .execute();
    expect(created).toHaveLength(1);
  });

  it('finds a message by id alone for the node uploader, whatever its tenant', async () => {
    const tenantId = crypto.randomUUID();
    const mailbox = await seedMailbox(tenantId);
    const { message } = await h.messages.create(ctxFor(tenantId), mailbox.id, {});

    expect(await h.messages.findByIdForUpload({}, message.id)).toMatchObject({
      id: message.id,
      tenantId,
      status: 'pending',
    });
    expect(await h.messages.findByIdForUpload({}, crypto.randomUUID())).toBeUndefined();
  });

  it('failStalePending marks only pending messages older than the cutoff failed', async () => {
    const tenantId = crypto.randomUUID();
    const mailbox = await seedMailbox(tenantId);
    const { message: stale } = await h.messages.create(ctxFor(tenantId), mailbox.id, {});
    const { message: fresh } = await h.messages.create(ctxFor(tenantId), mailbox.id, {});
    const { message: ready } = await h.messages.create(ctxFor(tenantId), mailbox.id, {});
    await h.messages.complete(ctxFor(tenantId), ready.id, { durationMs: 1, sizeBytes: 1 });
    const longAgo = new Date(Date.now() - 100 * 60 * 60 * 1000);
    await h.db.kysely
      .updateTable('messages')
      .set({ created_at: longAgo })
      .where('id', 'in', [stale.id, ready.id])
      .execute();

    const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000);
    expect(await h.messages.failStalePending({}, cutoff)).toBe(1);
    expect(await h.messages.findById(ctxFor(tenantId), stale.id)).toMatchObject({
      status: 'failed',
      failureReason: 'never_uploaded',
    });
    expect((await h.messages.findById(ctxFor(tenantId), fresh.id))?.status).toBe('pending');
    expect((await h.messages.findById(ctxFor(tenantId), ready.id))?.status).toBe('ready');
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
      h.db.kysely.selectFrom('messages').select('id').where('tenant_id', '=', tenantId).execute(),
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
