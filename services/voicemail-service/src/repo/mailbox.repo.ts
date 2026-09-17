import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { requireTenant } from '@cuc/db';
import { decryptString, encrypt, secretEquals, type KekProvider } from '@cuc/crypto';
import type { Storage } from '@cuc/storage';

import { validateExtensionId, validatePin } from '../domain/mailbox.js';
import type { VoicemailServiceDb } from '../schema.js';

export interface Mailbox {
  readonly id: string;
  readonly tenantId: string;
  readonly extensionId: string;
  readonly greetingStatus: 'none' | 'pending' | 'ready';
  readonly greetingObjectKey: string | null;
}

export interface CreateMailboxInput {
  readonly extensionId: string;
  readonly pin: string;
}

export class MailboxNotFoundError extends Error {
  override readonly name = 'MailboxNotFoundError';
}

export class MailboxAlreadyExistsError extends Error {
  override readonly name = 'MailboxAlreadyExistsError';
}

const COLUMNS = [
  'id',
  'tenant_id as tenantId',
  'extension_id as extensionId',
  'greeting_status as greetingStatus',
  'greeting_object_key as greetingObjectKey',
] as const;

function toMailbox(row: {
  id: string;
  tenantId: string;
  extensionId: string;
  greetingStatus: string;
  greetingObjectKey: string | null;
}): Mailbox {
  return { ...row, greetingStatus: row.greetingStatus as Mailbox['greetingStatus'] };
}

/** Every mailbox's own greeting lives under this prefix (05 §4-style layout: `voicemail/{mailboxId}/...`). */
function greetingObjectKey(mailboxId: string): string {
  return `voicemail/${mailboxId}/greeting.wav`;
}

function pinAssociatedData(tenantId: string, mailboxId: string): string {
  return `${tenantId}:mailboxes.pin_enc:${mailboxId}`;
}

/**
 * Data access for voicemail mailboxes (S2-16; 06's voicemail-service
 * section). Every query goes through `scoped(ctx)` (CLAUDE.md rule 2).
 *
 * Mailbox creation is this service's own tenant-facing API, not driven by
 * pbx-config-service's `extensions.voicemail_enabled` flag — that flag
 * exists (S1-09) but has no consumer yet on either side; wiring "flip the
 * flag, a mailbox appears" is a real future enhancement, flagged in
 * docs/decisions.md rather than reached into pbx-config-service for here.
 */
export function createMailboxRepo(db: Database<VoicemailServiceDb>, storage: Storage, kek: KekProvider) {
  return {
    list(ctx: DbContext): Promise<Mailbox[]> {
      return db
        .scoped(ctx)
        .selectFrom('mailboxes')
        .select(COLUMNS)
        .orderBy('created_at', 'asc')
        .execute()
        .then((rows) => rows.map(toMailbox));
    },

    findById(ctx: DbContext, id: string): Promise<Mailbox | undefined> {
      return db
        .scoped(ctx)
        .selectFrom('mailboxes')
        .select(COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : toMailbox(row)));
    },

    findByExtensionId(ctx: DbContext, extensionId: string): Promise<Mailbox | undefined> {
      return db
        .scoped(ctx)
        .selectFrom('mailboxes')
        .select(COLUMNS)
        .where('extension_id', '=', extensionId)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : toMailbox(row)));
    },

    async create(ctx: DbContext, input: CreateMailboxInput): Promise<Mailbox> {
      const { tenantId } = requireTenant(ctx);
      const extensionId = validateExtensionId(input.extensionId);
      const pin = validatePin(input.pin);

      const existing = await db
        .scoped(ctx)
        .selectFrom('mailboxes')
        .select('id')
        .where('extension_id', '=', extensionId)
        .executeTakeFirst();
      if (existing !== undefined) {
        throw new MailboxAlreadyExistsError(`Extension '${extensionId}' already has a mailbox.`);
      }

      const id = randomUUID();
      const pinEnc = await encrypt(kek, pin, pinAssociatedData(tenantId, id));

      // Idempotent (`@cuc/storage`'s own doc comment) — cheap to call on every
      // create rather than tracking "have we ever provisioned this tenant"
      // ourselves. Skipping this is the exact bug G-37 flagged in org-service's
      // own S1-04 brand-asset route (a presigned PUT against a never-provisioned
      // bucket 404s as `NoSuchBucket` on the real upload, not at presign time).
      await storage.forTenant(tenantId).provisionBucket();

      const now = new Date();
      await db
        .scoped(ctx)
        .insertInto('mailboxes')
        .values({
          id,
          extension_id: extensionId,
          pin_enc: pinEnc,
          greeting_status: 'none',
          greeting_object_key: null,
          created_at: now,
          updated_at: now,
          version: 1,
        })
        .execute();

      return {
        id,
        tenantId,
        extensionId,
        greetingStatus: 'none',
        greetingObjectKey: null,
      };
    },

    async resetPin(ctx: DbContext, id: string, pin: string): Promise<void> {
      const { tenantId } = requireTenant(ctx);
      const existing = await db
        .scoped(ctx)
        .selectFrom('mailboxes')
        .select('id')
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing === undefined) throw new MailboxNotFoundError(`No mailbox with id '${id}'.`);

      const validPin = validatePin(pin);
      const pinEnc = await encrypt(kek, validPin, pinAssociatedData(tenantId, id));
      await db
        .scoped(ctx)
        .updateTable('mailboxes')
        .set({ pin_enc: pinEnc, updated_at: new Date() })
        .where('id', '=', id)
        .execute();
    },

    /** Decrypts the stored PIN and compares in constant time — the decrypted value itself never leaves this function. */
    async verifyPin(ctx: DbContext, id: string, pin: string): Promise<boolean> {
      const { tenantId } = requireTenant(ctx);
      const row = await db
        .scoped(ctx)
        .selectFrom('mailboxes')
        .select('pin_enc')
        .where('id', '=', id)
        .executeTakeFirst();
      if (row === undefined) throw new MailboxNotFoundError(`No mailbox with id '${id}'.`);

      try {
        const stored = await decryptString(kek, row.pin_enc, pinAssociatedData(tenantId, id));
        return secretEquals(stored, pin);
      } catch {
        return false;
      }
    },

    async remove(ctx: DbContext, id: string): Promise<void> {
      const result = await db.scoped(ctx).deleteFrom('mailboxes').where('id', '=', id).executeTakeFirst();
      if (Number(result.numDeletedRows) === 0) {
        throw new MailboxNotFoundError(`No mailbox with id '${id}'.`);
      }
      // Messages are left orphaned in the DB and in S3 (same as media-asset's
      // own `remove()` in S2-07 — no cascade/cleanup convention exists yet
      // anywhere in this codebase; out of scope to invent here).
    },

    /** Returns a presigned PUT URL for the greeting and marks it `pending` — `completeGreeting` flips it to `ready`. */
    async presignGreeting(ctx: DbContext, id: string): Promise<{ uploadUrl: string; objectKey: string }> {
      const { tenantId } = requireTenant(ctx);
      const existing = await db
        .scoped(ctx)
        .selectFrom('mailboxes')
        .select('id')
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing === undefined) throw new MailboxNotFoundError(`No mailbox with id '${id}'.`);

      const objectKey = greetingObjectKey(id);
      const uploadUrl = await storage.forTenant(tenantId).presignPut(objectKey, { contentType: 'audio/wav' });

      await db
        .scoped(ctx)
        .updateTable('mailboxes')
        .set({ greeting_status: 'pending', greeting_object_key: objectKey, updated_at: new Date() })
        .where('id', '=', id)
        .execute();

      return { uploadUrl, objectKey };
    },

    async completeGreeting(ctx: DbContext, id: string): Promise<Mailbox> {
      const existing = await db
        .scoped(ctx)
        .selectFrom('mailboxes')
        .select(COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing === undefined) throw new MailboxNotFoundError(`No mailbox with id '${id}'.`);

      await db
        .scoped(ctx)
        .updateTable('mailboxes')
        .set({ greeting_status: 'ready', updated_at: new Date() })
        .where('id', '=', id)
        .execute();

      return toMailbox({ ...existing, greetingStatus: 'ready' });
    },
  };
}

export type MailboxRepo = ReturnType<typeof createMailboxRepo>;
