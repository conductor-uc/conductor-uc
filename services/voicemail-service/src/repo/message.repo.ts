import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { requireTenant } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';
import type { Storage } from '@cuc/storage';

import { voicemailEvents } from '../events.js';
import type { VoicemailServiceDb } from '../schema.js';

export interface VoicemailMessage {
  readonly id: string;
  readonly tenantId: string;
  readonly mailboxId: string;
  readonly status: 'pending' | 'ready' | 'failed';
  readonly objectKey: string;
  readonly callerIdName: string | null;
  readonly callerIdNumber: string | null;
  readonly durationMs: number | null;
  readonly sizeBytes: number | null;
  readonly isRead: boolean;
  readonly createdAt: Date;
}

export interface CreateMessageInput {
  readonly callerIdName?: string | null;
  readonly callerIdNumber?: string | null;
}

export interface CompleteMessageInput {
  readonly durationMs: number;
  readonly sizeBytes: number;
}

export class MessageNotFoundError extends Error {
  override readonly name = 'MessageNotFoundError';
}

const COLUMNS = [
  'id',
  'tenant_id as tenantId',
  'mailbox_id as mailboxId',
  'status',
  'object_key as objectKey',
  'caller_id_name as callerIdName',
  'caller_id_number as callerIdNumber',
  'duration_ms as durationMs',
  'size_bytes as sizeBytes',
  'is_read as isRead',
  'created_at as createdAt',
] as const;

function toMessage(row: {
  id: string;
  tenantId: string;
  mailboxId: string;
  status: string;
  objectKey: string;
  callerIdName: string | null;
  callerIdNumber: string | null;
  durationMs: number | null;
  sizeBytes: number | null;
  isRead: boolean | number;
  createdAt: Date;
}): VoicemailMessage {
  return {
    ...row,
    status: row.status as VoicemailMessage['status'],
    isRead: Boolean(row.isRead),
  };
}

/** 05 §4-style object layout: one WAV per message, under its own mailbox's prefix. */
function messageObjectKey(mailboxId: string, messageId: string): string {
  return `voicemail/${mailboxId}/${messageId}.wav`;
}

/**
 * Data access for voicemail messages (S2-16). Every query goes through
 * `scoped(ctx)` (CLAUDE.md rule 2).
 *
 * `voicemail.mailbox.mwi_changed` is enqueued in the same transaction as
 * every write that changes a mailbox's unread state (`complete`, `markRead`,
 * `remove` of an unread message) — CLAUDE.md rule 6, the transactional
 * outbox, not a direct publish.
 */
export function createMessageRepo(db: Database<VoicemailServiceDb>, storage: Storage) {
  return {
    /** Ready messages only, oldest first — what the retrieval menu and the console both walk through. */
    listReady(ctx: DbContext, mailboxId: string): Promise<VoicemailMessage[]> {
      return db
        .scoped(ctx)
        .selectFrom('messages')
        .select(COLUMNS)
        .where('mailbox_id', '=', mailboxId)
        .where('status', '=', 'ready')
        .orderBy('created_at', 'asc')
        .execute()
        .then((rows) => rows.map(toMessage));
    },

    findById(ctx: DbContext, id: string): Promise<VoicemailMessage | undefined> {
      return db
        .scoped(ctx)
        .selectFrom('messages')
        .select(COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : toMessage(row)));
    },

    /** Creates a `pending` row and returns a presigned PUT URL for the FS-side spool uploader (via telephony-config) to upload the recorded WAV directly to. */
    async create(
      ctx: DbContext,
      mailboxId: string,
      input: CreateMessageInput,
    ): Promise<{ message: VoicemailMessage; uploadUrl: string }> {
      const { tenantId } = requireTenant(ctx);
      const id = randomUUID();
      const objectKey = messageObjectKey(mailboxId, id);
      const uploadUrl = await storage.forTenant(tenantId).presignPut(objectKey, { contentType: 'audio/wav' });

      const now = new Date();
      await db
        .scoped(ctx)
        .insertInto('messages')
        .values({
          id,
          mailbox_id: mailboxId,
          status: 'pending',
          object_key: objectKey,
          caller_id_name: input.callerIdName ?? null,
          caller_id_number: input.callerIdNumber ?? null,
          duration_ms: null,
          size_bytes: null,
          is_read: false,
          created_at: now,
          updated_at: now,
          version: 1,
        })
        .execute();

      return {
        message: {
          id,
          tenantId,
          mailboxId,
          status: 'pending',
          objectKey,
          callerIdName: input.callerIdName ?? null,
          callerIdNumber: input.callerIdNumber ?? null,
          durationMs: null,
          sizeBytes: null,
          isRead: false,
          createdAt: now,
        },
        uploadUrl,
      };
    },

    async complete(ctx: DbContext, id: string, input: CompleteMessageInput): Promise<VoicemailMessage> {
      const { tenantId } = requireTenant(ctx);
      let result: VoicemailMessage | undefined;

      await db.scoped(ctx).transaction(async (trx, raw) => {
        const existing = await trx
          .selectFrom('messages')
          .select(COLUMNS)
          .where('id', '=', id)
          .executeTakeFirst();
        if (existing === undefined) throw new MessageNotFoundError(`No message with id '${id}'.`);

        await trx
          .updateTable('messages')
          .set({
            status: 'ready',
            duration_ms: input.durationMs,
            size_bytes: input.sizeBytes,
            updated_at: new Date(),
          })
          .where('id', '=', id)
          .execute();

        await enqueueEvent(raw, voicemailEvents, {
          type: 'voicemail.message.created',
          data: { messageId: id, mailboxId: existing.mailboxId },
          orgContext: { tenantId },
        });
        await enqueueEvent(raw, voicemailEvents, {
          type: 'voicemail.mailbox.mwi_changed',
          data: { mailboxId: existing.mailboxId },
          orgContext: { tenantId },
        });

        result = toMessage({
          ...existing,
          status: 'ready',
          durationMs: input.durationMs,
          sizeBytes: input.sizeBytes,
        });
      });

      return result!;
    },

    async fail(ctx: DbContext, id: string): Promise<void> {
      const result = await db
        .scoped(ctx)
        .updateTable('messages')
        .set({ status: 'failed', updated_at: new Date() })
        .where('id', '=', id)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) throw new MessageNotFoundError(`No message with id '${id}'.`);
    },

    async markRead(ctx: DbContext, id: string): Promise<VoicemailMessage> {
      const { tenantId } = requireTenant(ctx);
      let result: VoicemailMessage | undefined;

      await db.scoped(ctx).transaction(async (trx, raw) => {
        const existing = await trx
          .selectFrom('messages')
          .select(COLUMNS)
          .where('id', '=', id)
          .executeTakeFirst();
        if (existing === undefined) throw new MessageNotFoundError(`No message with id '${id}'.`);

        const wasUnread = !existing.isRead;
        await trx
          .updateTable('messages')
          .set({ is_read: true, updated_at: new Date() })
          .where('id', '=', id)
          .execute();

        if (wasUnread) {
          await enqueueEvent(raw, voicemailEvents, {
            type: 'voicemail.mailbox.mwi_changed',
            data: { mailboxId: existing.mailboxId },
            orgContext: { tenantId },
          });
        }

        result = toMessage({ ...existing, isRead: true });
      });

      return result!;
    },

    async remove(ctx: DbContext, id: string): Promise<void> {
      const { tenantId } = requireTenant(ctx);

      await db.scoped(ctx).transaction(async (trx, raw) => {
        const existing = await trx
          .selectFrom('messages')
          .select(COLUMNS)
          .where('id', '=', id)
          .executeTakeFirst();
        if (existing === undefined) throw new MessageNotFoundError(`No message with id '${id}'.`);

        await trx.deleteFrom('messages').where('id', '=', id).execute();

        if (!existing.isRead) {
          await enqueueEvent(raw, voicemailEvents, {
            type: 'voicemail.mailbox.mwi_changed',
            data: { mailboxId: existing.mailboxId },
            orgContext: { tenantId },
          });
        }
      });
      // S3 object left in place — same "no cleanup convention yet" gap as
      // `mailbox.repo.ts`'s own `remove()`.
    },
  };
}

export type MessageRepo = ReturnType<typeof createMessageRepo>;
