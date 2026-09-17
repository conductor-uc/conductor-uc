import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { crossTenantProbe, databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';

import { InvalidExtensionIdError, InvalidPinError } from '../src/domain/mailbox.js';
import { MailboxAlreadyExistsError, MailboxNotFoundError } from '../src/repo/mailbox.repo.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());

describe.skipIf(skipReason !== undefined)('mailbox repo', () => {
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

  it('creates a mailbox with an encrypted PIN, distinct from the plaintext', async () => {
    const tenantId = crypto.randomUUID();
    const extensionId = crypto.randomUUID();
    const mailbox = await h.mailboxes.create(ctxFor(tenantId), { extensionId, pin: '1234' });

    expect(mailbox).toMatchObject({
      tenantId,
      extensionId,
      greetingStatus: 'none',
      greetingObjectKey: null,
    });

    const row = await h.db.kysely
      .selectFrom('mailboxes')
      .select('pin_enc')
      .where('id', '=', mailbox.id)
      .executeTakeFirstOrThrow();
    expect(row.pin_enc).not.toBe('1234');
    expect(row.pin_enc.startsWith('enc1.')).toBe(true);
  });

  it('rejects a non-numeric or wrong-length PIN', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.mailboxes.create(ctxFor(tenantId), { extensionId: crypto.randomUUID(), pin: 'abcd' }),
    ).rejects.toThrow(InvalidPinError);
    await expect(
      h.mailboxes.create(ctxFor(tenantId), { extensionId: crypto.randomUUID(), pin: '12' }),
    ).rejects.toThrow(InvalidPinError);
  });

  it('rejects an empty extensionId', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.mailboxes.create(ctxFor(tenantId), { extensionId: '  ', pin: '1234' }),
    ).rejects.toThrow(InvalidExtensionIdError);
  });

  it('refuses a second mailbox for the same extension', async () => {
    const tenantId = crypto.randomUUID();
    const extensionId = crypto.randomUUID();
    await h.mailboxes.create(ctxFor(tenantId), { extensionId, pin: '1234' });
    await expect(
      h.mailboxes.create(ctxFor(tenantId), { extensionId, pin: '5678' }),
    ).rejects.toThrow(MailboxAlreadyExistsError);
  });

  it('finds a mailbox by its extension id', async () => {
    const tenantId = crypto.randomUUID();
    const extensionId = crypto.randomUUID();
    const created = await h.mailboxes.create(ctxFor(tenantId), { extensionId, pin: '1234' });
    const found = await h.mailboxes.findByExtensionId(ctxFor(tenantId), extensionId);
    expect(found?.id).toBe(created.id);
  });

  it('verifies a correct PIN and rejects an incorrect one', async () => {
    const tenantId = crypto.randomUUID();
    const mailbox = await h.mailboxes.create(ctxFor(tenantId), {
      extensionId: crypto.randomUUID(),
      pin: '4242',
    });

    expect(await h.mailboxes.verifyPin(ctxFor(tenantId), mailbox.id, '4242')).toBe(true);
    expect(await h.mailboxes.verifyPin(ctxFor(tenantId), mailbox.id, '0000')).toBe(false);
  });

  it('resetPin changes which PIN verifies', async () => {
    const tenantId = crypto.randomUUID();
    const mailbox = await h.mailboxes.create(ctxFor(tenantId), {
      extensionId: crypto.randomUUID(),
      pin: '1111',
    });

    await h.mailboxes.resetPin(ctxFor(tenantId), mailbox.id, '9999');
    expect(await h.mailboxes.verifyPin(ctxFor(tenantId), mailbox.id, '1111')).toBe(false);
    expect(await h.mailboxes.verifyPin(ctxFor(tenantId), mailbox.id, '9999')).toBe(true);
  });

  it('404s verifying a PIN for a mailbox that does not exist', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.mailboxes.verifyPin(ctxFor(tenantId), crypto.randomUUID(), '1234'),
    ).rejects.toThrow(MailboxNotFoundError);
  });

  it('presignGreeting returns a real, usable presigned upload URL and marks the greeting pending', async () => {
    const tenantId = crypto.randomUUID();
    const mailbox = await h.mailboxes.create(ctxFor(tenantId), {
      extensionId: crypto.randomUUID(),
      pin: '1234',
    });

    const { uploadUrl, objectKey } = await h.mailboxes.presignGreeting(ctxFor(tenantId), mailbox.id);
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'audio/wav' },
      body: 'not really wav bytes, just proving the URL/bucket work',
    });
    expect(response.ok).toBe(true);

    const pending = await h.mailboxes.findById(ctxFor(tenantId), mailbox.id);
    expect(pending?.greetingStatus).toBe('pending');
    expect(pending?.greetingObjectKey).toBe(objectKey);

    const completed = await h.mailboxes.completeGreeting(ctxFor(tenantId), mailbox.id);
    expect(completed.greetingStatus).toBe('ready');

    const fetched = await h.storage.forTenant(tenantId).getObject(objectKey);
    expect(fetched.toString('utf8')).toBe('not really wav bytes, just proving the URL/bucket work');
  });

  it('404s removing a mailbox that does not exist', async () => {
    const tenantId = crypto.randomUUID();
    await expect(h.mailboxes.remove(ctxFor(tenantId), crypto.randomUUID())).rejects.toThrow(
      MailboxNotFoundError,
    );
  });

  it('removes its own mailbox', async () => {
    const tenantId = crypto.randomUUID();
    const mailbox = await h.mailboxes.create(ctxFor(tenantId), {
      extensionId: crypto.randomUUID(),
      pin: '1234',
    });
    await h.mailboxes.remove(ctxFor(tenantId), mailbox.id);
    expect(await h.mailboxes.findById(ctxFor(tenantId), mailbox.id)).toBeUndefined();
  });

  // 05 §2.4: every repository test suite includes a cross-tenant probe.
  crossTenantProbe({
    name: 'mailboxes',
    seed: async (tenantId) => {
      const mailbox = await h.mailboxes.create(ctxFor(tenantId), {
        extensionId: crypto.randomUUID(),
        pin: '1234',
      });
      return mailbox.id;
    },
    list: (tenantId) => h.mailboxes.list(ctxFor(tenantId)),
    findById: (tenantId, id) => h.mailboxes.findById(ctxFor(tenantId), id),
    remove: (tenantId, id) =>
      h.mailboxes
        .remove(ctxFor(tenantId), id)
        .then(() => 1)
        .catch((error: unknown) => {
          if (error instanceof MailboxNotFoundError) return 0;
          throw error;
        }),
  });
});
