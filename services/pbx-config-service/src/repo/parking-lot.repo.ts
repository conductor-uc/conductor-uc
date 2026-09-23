import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { requireTenant } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import type { DestinationType } from '../domain/dids.js';
import {
  slotRangesOverlap,
  validateLabel,
  validateReturnDestination,
  validateSlotRange,
  validateTimeoutSeconds,
} from '../domain/parking-lot.js';
import { pbxEvents } from '../events.js';
import type { PbxConfigServiceDb } from '../schema.js';

export interface ParkingLot {
  readonly id: string;
  readonly tenantId: string;
  readonly label: string;
  readonly slotStart: number;
  readonly slotEnd: number;
  readonly timeoutSeconds: number;
  readonly returnDestinationType: DestinationType | null;
  readonly returnDestinationId: string | null;
}

export interface CreateParkingLotInput {
  readonly label: string;
  readonly slotStart: number;
  readonly slotEnd: number;
  readonly timeoutSeconds: number;
  readonly returnDestinationType?: string | null;
  readonly returnDestinationId?: string | null;
}

export type UpdateParkingLotInput = Partial<CreateParkingLotInput>;

export class ParkingLotNotFoundError extends Error {
  override readonly name = 'ParkingLotNotFoundError';
}

/** This lot's slot range overlaps another lot already in the same tenant. */
export class ParkingLotSlotOverlapError extends Error {
  override readonly name = 'ParkingLotSlotOverlapError';
}

interface ParkingLotRow {
  id: string;
  tenant_id: string;
  label: string;
  slot_start: number;
  slot_end: number;
  timeout_seconds: number;
  return_destination_type: string | null;
  return_destination_id: string | null;
}

function toParkingLot(row: ParkingLotRow): ParkingLot {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    label: row.label,
    slotStart: row.slot_start,
    slotEnd: row.slot_end,
    timeoutSeconds: row.timeout_seconds,
    returnDestinationType: row.return_destination_type as DestinationType | null,
    returnDestinationId: row.return_destination_id,
  };
}

async function assertNoSlotOverlap(
  db: Database<PbxConfigServiceDb>,
  ctx: DbContext,
  range: { start: number; end: number },
  excludeId?: string,
): Promise<void> {
  const existing = await db.scoped(ctx).selectFrom('parking_lots').selectAll().execute();
  for (const row of existing) {
    if (row.id === excludeId) continue;
    if (slotRangesOverlap(range, { start: row.slot_start, end: row.slot_end })) {
      throw new ParkingLotSlotOverlapError(
        `Slots ${String(range.start)}-${String(range.end)} overlap lot '${row.label}' (${String(row.slot_start)}-${String(row.slot_end)}).`,
      );
    }
  }
}

/**
 * Data access for parking lots (S2-14; 05 §3.3). Every query goes through
 * `scoped(ctx)` (CLAUDE.md rule 2). Publishes `pbx.parking_lot.*` the same
 * thin, "re-fetch current state" way `pbx.queue.*` does — telephony-config
 * keeps a local projected mirror, the same hot-xml_curl-path reasoning
 * `queue.repo.ts`'s own doc comment gives.
 */
export function createParkingLotRepo(db: Database<PbxConfigServiceDb>) {
  return {
    list: (ctx: DbContext): Promise<ParkingLot[]> =>
      db
        .scoped(ctx)
        .selectFrom('parking_lots')
        .selectAll()
        .orderBy('label', 'asc')
        .execute()
        .then((rows) => rows.map(toParkingLot)),

    findById: (ctx: DbContext, id: string): Promise<ParkingLot | undefined> =>
      db
        .scoped(ctx)
        .selectFrom('parking_lots')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : toParkingLot(row))),

    async create(ctx: DbContext, input: CreateParkingLotInput): Promise<ParkingLot> {
      const { tenantId } = requireTenant(ctx);
      const label = validateLabel(input.label);
      const slots = validateSlotRange(input.slotStart, input.slotEnd);
      const timeoutSeconds = validateTimeoutSeconds(input.timeoutSeconds);
      const returnDestination = validateReturnDestination(
        input.returnDestinationType,
        input.returnDestinationId,
      );
      await assertNoSlotOverlap(db, ctx, slots);

      const id = randomUUID();
      const now = new Date();

      await db.scoped(ctx).transaction(async (trx, raw) => {
        await trx
          .insertInto('parking_lots')
          .values({
            id,
            label,
            slot_start: slots.start,
            slot_end: slots.end,
            timeout_seconds: timeoutSeconds,
            return_destination_type: returnDestination?.type ?? null,
            return_destination_id: returnDestination?.id ?? null,
            created_at: now,
            updated_at: now,
            version: 1,
          })
          .execute();

        await enqueueEvent(raw, pbxEvents, {
          type: 'pbx.parking_lot.created',
          data: { parkingLotId: id },
          orgContext: { tenantId },
          ...(ctx.actorId === undefined || ctx.orgId === undefined
            ? {}
            : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });

      return {
        id,
        tenantId,
        label,
        slotStart: slots.start,
        slotEnd: slots.end,
        timeoutSeconds,
        returnDestinationType: returnDestination?.type ?? null,
        returnDestinationId: returnDestination?.id ?? null,
      };
    },

    async update(ctx: DbContext, id: string, input: UpdateParkingLotInput): Promise<ParkingLot> {
      const { tenantId } = requireTenant(ctx);
      const existing = await db
        .scoped(ctx)
        .selectFrom('parking_lots')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing === undefined) {
        throw new ParkingLotNotFoundError(`No parking lot with id '${id}'.`);
      }
      const current = toParkingLot(existing);

      const label = input.label === undefined ? current.label : validateLabel(input.label);
      const slots =
        input.slotStart === undefined && input.slotEnd === undefined
          ? { start: current.slotStart, end: current.slotEnd }
          : validateSlotRange(
              input.slotStart ?? current.slotStart,
              input.slotEnd ?? current.slotEnd,
            );
      const timeoutSeconds =
        input.timeoutSeconds === undefined
          ? current.timeoutSeconds
          : validateTimeoutSeconds(input.timeoutSeconds);
      const returnDestination =
        input.returnDestinationType === undefined && input.returnDestinationId === undefined
          ? current.returnDestinationType === null
            ? null
            : { type: current.returnDestinationType, id: current.returnDestinationId as string }
          : validateReturnDestination(input.returnDestinationType, input.returnDestinationId);

      await assertNoSlotOverlap(db, ctx, slots, id);

      await db.scoped(ctx).transaction(async (trx, raw) => {
        await trx
          .updateTable('parking_lots')
          .set({
            label,
            slot_start: slots.start,
            slot_end: slots.end,
            timeout_seconds: timeoutSeconds,
            return_destination_type: returnDestination?.type ?? null,
            return_destination_id: returnDestination?.id ?? null,
            updated_at: new Date(),
            version: existing.version + 1,
          })
          .where('id', '=', id)
          .execute();

        await enqueueEvent(raw, pbxEvents, {
          type: 'pbx.parking_lot.updated',
          data: { parkingLotId: id },
          orgContext: { tenantId },
          ...(ctx.actorId === undefined || ctx.orgId === undefined
            ? {}
            : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });

      return {
        id,
        tenantId,
        label,
        slotStart: slots.start,
        slotEnd: slots.end,
        timeoutSeconds,
        returnDestinationType: returnDestination?.type ?? null,
        returnDestinationId: returnDestination?.id ?? null,
      };
    },

    async remove(ctx: DbContext, id: string): Promise<void> {
      const { tenantId } = requireTenant(ctx);

      await db.scoped(ctx).transaction(async (trx, raw) => {
        const result = await trx.deleteFrom('parking_lots').where('id', '=', id).executeTakeFirst();
        if (Number(result.numDeletedRows) === 0) {
          throw new ParkingLotNotFoundError(`No parking lot with id '${id}'.`);
        }

        await enqueueEvent(raw, pbxEvents, {
          type: 'pbx.parking_lot.deleted',
          data: { parkingLotId: id },
          orgContext: { tenantId },
          ...(ctx.actorId === undefined || ctx.orgId === undefined
            ? {}
            : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });
    },
  };
}

export type ParkingLotRepo = ReturnType<typeof createParkingLotRepo>;
