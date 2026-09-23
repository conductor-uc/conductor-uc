import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { isDuplicateKeyError, requireTenant } from '@cuc/db';
import { decryptString, encrypt, secretEquals, type KekProvider } from '@cuc/crypto';
import { enqueueEvent } from '@cuc/events';

import {
  validateLabel,
  validateLayout,
  validateMaxMembers,
  validateNumber,
  validatePin,
} from '../domain/conference-room.js';
import { pbxEvents } from '../events.js';
import type { PbxConfigServiceDb } from '../schema.js';

export interface ConferenceRoom {
  readonly id: string;
  readonly tenantId: string;
  readonly label: string;
  readonly number: string;
  readonly pinRequired: boolean;
  readonly video: boolean;
  readonly layout: string | null;
  readonly maxMembers: number;
}

export interface CreateConferenceRoomInput {
  readonly label: string;
  readonly number: string;
  readonly pin?: string | null;
  readonly video?: boolean;
  readonly layout?: string | null;
  readonly maxMembers: number;
}

export interface UpdateConferenceRoomInput {
  readonly label?: string;
  readonly number?: string;
  readonly pin?: string | null;
  readonly video?: boolean;
  readonly layout?: string | null;
  readonly maxMembers?: number;
}

export class ConferenceRoomNotFoundError extends Error {
  override readonly name = 'ConferenceRoomNotFoundError';
}

/** This room's number is already in use by another room in the same tenant — the `(tenant_id, number)` unique index. */
export class ConferenceRoomNumberTakenError extends Error {
  override readonly name = 'ConferenceRoomNumberTakenError';
}

interface ConferenceRoomRow {
  id: string;
  tenant_id: string;
  label: string;
  number: string;
  pin_enc: string | null;
  video: boolean;
  layout: string | null;
  max_members: number;
}

function toConferenceRoom(row: ConferenceRoomRow): ConferenceRoom {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    label: row.label,
    number: row.number,
    pinRequired: row.pin_enc !== null,
    video: row.video,
    layout: row.layout,
    maxMembers: row.max_members,
  };
}

function pinAssociatedData(tenantId: string, roomId: string): string {
  return `${tenantId}:conference_rooms.pin_enc:${roomId}`;
}

/**
 * Data access for conference rooms (S2-15; 05 §3.3). Every query goes
 * through `scoped(ctx)` (CLAUDE.md rule 2). Publishes `pbx.conference_room.*`
 * the same thin, "re-fetch current state" way `pbx.parking_lot.*` does.
 *
 * `pin_enc` is envelope-encrypted (07 §5), mirroring `voicemail-service`'s
 * `mailbox.repo.ts` — a room's own list/find/API surface never exposes the
 * plaintext PIN or even the ciphertext, only whether one is set
 * (`pinRequired`). `verifyPin` is the only way to check a submitted PIN, the
 * same `decryptString` + `secretEquals` (constant-time) shape
 * `mailbox.repo.ts`'s `verifyPin` uses.
 */
export function createConferenceRoomRepo(db: Database<PbxConfigServiceDb>, kek: KekProvider) {
  return {
    list: (ctx: DbContext): Promise<ConferenceRoom[]> =>
      db
        .scoped(ctx)
        .selectFrom('conference_rooms')
        .selectAll()
        .orderBy('label', 'asc')
        .execute()
        .then((rows) => rows.map(toConferenceRoom)),

    findById: (ctx: DbContext, id: string): Promise<ConferenceRoom | undefined> =>
      db
        .scoped(ctx)
        .selectFrom('conference_rooms')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : toConferenceRoom(row))),

    async create(ctx: DbContext, input: CreateConferenceRoomInput): Promise<ConferenceRoom> {
      const { tenantId } = requireTenant(ctx);
      const label = validateLabel(input.label);
      const number = validateNumber(input.number);
      const pin = validatePin(input.pin);
      const video = input.video ?? false;
      const layout = validateLayout(input.layout);
      const maxMembers = validateMaxMembers(input.maxMembers);

      const id = randomUUID();
      const now = new Date();
      const pinEnc = pin === null ? null : await encrypt(kek, pin, pinAssociatedData(tenantId, id));

      try {
        await db.scoped(ctx).transaction(async (trx, raw) => {
          await trx
            .insertInto('conference_rooms')
            .values({
              id,
              label,
              number,
              pin_enc: pinEnc,
              video,
              layout,
              max_members: maxMembers,
              created_at: now,
              updated_at: now,
              version: 1,
            })
            .execute();

          await enqueueEvent(raw, pbxEvents, {
            type: 'pbx.conference_room.created',
            data: { conferenceRoomId: id },
            orgContext: { tenantId },
            ...(ctx.actorId === undefined || ctx.orgId === undefined
              ? {}
              : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
            ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
          });
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new ConferenceRoomNumberTakenError(
            `Conference room number '${number}' is already in use.`,
          );
        }
        throw error;
      }

      return {
        id,
        tenantId,
        label,
        number,
        pinRequired: pin !== null,
        video,
        layout,
        maxMembers,
      };
    },

    async update(
      ctx: DbContext,
      id: string,
      input: UpdateConferenceRoomInput,
    ): Promise<ConferenceRoom> {
      const { tenantId } = requireTenant(ctx);
      const existing = await db
        .scoped(ctx)
        .selectFrom('conference_rooms')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing === undefined) {
        throw new ConferenceRoomNotFoundError(`No conference room with id '${id}'.`);
      }
      const current = toConferenceRoom(existing);

      const label = input.label === undefined ? current.label : validateLabel(input.label);
      const number = input.number === undefined ? current.number : validateNumber(input.number);
      const video = input.video ?? current.video;
      const layout = input.layout === undefined ? current.layout : validateLayout(input.layout);
      const maxMembers =
        input.maxMembers === undefined ? current.maxMembers : validateMaxMembers(input.maxMembers);

      let pinEnc = existing.pin_enc;
      if (input.pin !== undefined) {
        const pin = validatePin(input.pin);
        pinEnc = pin === null ? null : await encrypt(kek, pin, pinAssociatedData(tenantId, id));
      }

      try {
        await db.scoped(ctx).transaction(async (trx, raw) => {
          await trx
            .updateTable('conference_rooms')
            .set({
              label,
              number,
              pin_enc: pinEnc,
              video,
              layout,
              max_members: maxMembers,
              updated_at: new Date(),
              version: existing.version + 1,
            })
            .where('id', '=', id)
            .execute();

          await enqueueEvent(raw, pbxEvents, {
            type: 'pbx.conference_room.updated',
            data: { conferenceRoomId: id },
            orgContext: { tenantId },
            ...(ctx.actorId === undefined || ctx.orgId === undefined
              ? {}
              : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
            ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
          });
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new ConferenceRoomNumberTakenError(
            `Conference room number '${number}' is already in use.`,
          );
        }
        throw error;
      }

      return {
        id,
        tenantId,
        label,
        number,
        pinRequired: pinEnc !== null,
        video,
        layout,
        maxMembers,
      };
    },

    async remove(ctx: DbContext, id: string): Promise<void> {
      const { tenantId } = requireTenant(ctx);

      await db.scoped(ctx).transaction(async (trx, raw) => {
        const result = await trx
          .deleteFrom('conference_rooms')
          .where('id', '=', id)
          .executeTakeFirst();
        if (Number(result.numDeletedRows) === 0) {
          throw new ConferenceRoomNotFoundError(`No conference room with id '${id}'.`);
        }

        await enqueueEvent(raw, pbxEvents, {
          type: 'pbx.conference_room.deleted',
          data: { conferenceRoomId: id },
          orgContext: { tenantId },
          ...(ctx.actorId === undefined || ctx.orgId === undefined
            ? {}
            : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });
    },

    /** Decrypts the stored PIN and compares in constant time — the decrypted value itself never leaves this function. No PIN required (`pin_enc` null) always fails, since there is nothing to match. */
    async verifyPin(ctx: DbContext, id: string, pin: string): Promise<boolean> {
      const { tenantId } = requireTenant(ctx);
      const row = await db
        .scoped(ctx)
        .selectFrom('conference_rooms')
        .select('pin_enc')
        .where('id', '=', id)
        .executeTakeFirst();
      if (row === undefined)
        throw new ConferenceRoomNotFoundError(`No conference room with id '${id}'.`);
      if (row.pin_enc === null) return false;

      try {
        const stored = await decryptString(kek, row.pin_enc, pinAssociatedData(tenantId, id));
        return secretEquals(stored, pin);
      } catch {
        return false;
      }
    },
  };
}

export type ConferenceRoomRepo = ReturnType<typeof createConferenceRoomRepo>;
