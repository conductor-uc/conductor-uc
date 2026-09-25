import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { requireTenant } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import { messageObjectKey } from '../domain/message.js';
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
  readonly sha256: string | null;
  readonly failureReason: string | null;
  readonly isRead: boolean;
  readonly createdAt: Date;
}

export interface CreateMessageInput {
  readonly callerIdName?: string | null;
  readonly callerIdNumber?: string | null;
}

export interface CompleteMessageInput {
  readonly durationMs: number | null;
  readonly sizeBytes: number;
  readonly sha256?: string | null;
}

export class MessageNotFoundError extends Error {
  override readonly name = 'MessageNotFoundError';
}

/** The message is already ready: its audio arrived before. */
export class MessageAlreadyReadyError extends Error {
  override readonly name = 'MessageAlreadyReadyError';
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
  'sha256',
  'failure_reason as failureReason',
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
  sha256: string | null;
  failureReason: string | null;
  isRead: boolean | number;
  createdAt: Date;
}): VoicemailMessage {
  return {
    ...row,
    status: row.status as VoicemailMessage['status'],
    isRead: Boolean(row.isRead),
  };
}

/**
 * Data access for voicemail messages (S2-16, S5-16). Every tenant query goes
 * through `scoped(ctx)` (CLAUDE.md rule 2). The two cross-tenant ones,
 * `findByIdForUpload` (the node uploader knows only the opaque message id in
 * a spool file name) and the pending sweep's `failStalePending`, use
 * `unscoped(ctx, reason)`, as recording-service's do; the uploader's routes
 * then act on the row through a `scoped` context for its own tenant.
 *
 * `voicemail.mailbox.mwi_changed` is enqueued in the same transaction as
 * every write that changes a mailbox's unread state (`complete`, `markRead`,
 * `remove` of an unread message) — CLAUDE.md rule 6, the transactional
 * outbox, not a direct publish.
 */
export function createMessageRepo(db: Database<VoicemailServiceDb>) {
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

    /** For the node uploader, which holds only the opaque id from a `vm-<id>.wav` spool file name. */
    findByIdForUpload(ctx: DbContext, id: string): Promise<VoicemailMessage | undefined> {
      return db
        .unscoped(ctx, 'node uploader resolving a voicemail spool file by its opaque message id')
        .selectFrom('messages')
        .select(COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : toMessage(row)));
    },

    /**
     * Creates the `pending` row before the caller is recorded (S5-16): its id names the spool
     * file `voicemail.lua` records to, which the node uploader later delivers through the
     * `/internal/v1/voicemail/messages/:id/...` routes.
     */
    async create(
      ctx: DbContext,
      mailboxId: string,
      input: CreateMessageInput,
    ): Promise<{ message: VoicemailMessage }> {
      const { tenantId } = requireTenant(ctx);
      const id = randomUUID();
      const objectKey = messageObjectKey(mailboxId, id);

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
          sha256: null,
          failure_reason: null,
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
          sha256: null,
          failureReason: null,
          isRead: false,
          createdAt: now,
        },
      };
    },

    /**
     * Marks a message ready once its audio is verified in storage (the uploader's route does
     * the verifying). A `failed` one may still complete: audio that arrives after the pending
     * sweep gave up on it (a long storage outage) is not thrown away, as with recordings.
     * Emits `voicemail.message.created` and `voicemail.mailbox.mwi_changed`.
     */
    async complete(
      ctx: DbContext,
      id: string,
      input: CompleteMessageInput,
    ): Promise<VoicemailMessage> {
      const { tenantId } = requireTenant(ctx);
      let result: VoicemailMessage | undefined;

      await db.scoped(ctx).transaction(async (trx, raw) => {
        const existing = await trx
          .selectFrom('messages')
          .select(COLUMNS)
          .where('id', '=', id)
          .executeTakeFirst();
        if (existing === undefined) throw new MessageNotFoundError(`No message with id '${id}'.`);
        if (existing.status === 'ready') {
          throw new MessageAlreadyReadyError(`Message '${id}' is already ready.`);
        }

        await trx
          .updateTable('messages')
          .set({
            status: 'ready',
            duration_ms: input.durationMs,
            size_bytes: input.sizeBytes,
            sha256: input.sha256 ?? null,
            failure_reason: null,
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
          sha256: input.sha256 ?? null,
          failureReason: null,
        });
      });

      return result!;
    },

    /** Marks a message that never got usable audio failed. A ready message is left alone. */
    async fail(ctx: DbContext, id: string, reason: string): Promise<void> {
      const result = await db
        .scoped(ctx)
        .updateTable('messages')
        .set({ status: 'failed', failure_reason: reason.slice(0, 128), updated_at: new Date() })
        .where('id', '=', id)
        .where('status', 'in', ['pending', 'failed'])
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        const exists = await this.findById(ctx, id);
        if (exists === undefined) throw new MessageNotFoundError(`No message with id '${id}'.`);
      }
    },

    /**
     * Pending messages created before `cutoff` whose audio never arrived (the caller hung up
     * before anything was recorded, or the node died with the file): marks them failed.
     * Returns how many. Background job only.
     */
    async failStalePending(ctx: DbContext, cutoff: Date): Promise<number> {
      const result = await db
        .unscoped(ctx, 'pending sweep: voicemail messages created but never uploaded')
        .updateTable('messages')
        .set({ status: 'failed', failure_reason: 'never_uploaded', updated_at: new Date() })
        .where('status', '=', 'pending')
        .where('created_at', '<', cutoff)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
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
