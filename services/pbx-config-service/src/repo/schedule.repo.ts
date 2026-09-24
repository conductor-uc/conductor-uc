import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { requireTenant } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import {
  validateHolidays,
  validateLabel,
  validateRules,
  validateTimezone,
  type ScheduleHoliday,
  type ScheduleRule,
} from '../domain/schedule.js';
import { pbxEvents } from '../events.js';
import type { PbxConfigServiceDb } from '../schema.js';

export interface Schedule {
  readonly id: string;
  readonly tenantId: string;
  readonly label: string;
  readonly timezone: string;
  readonly rules: readonly ScheduleRule[];
  readonly holidays: readonly ScheduleHoliday[];
}

export interface CreateScheduleInput {
  readonly label: string;
  readonly timezone: string;
  readonly rules?: readonly ScheduleRule[];
  readonly holidays?: readonly ScheduleHoliday[];
}

export type UpdateScheduleInput = Partial<CreateScheduleInput>;

export class ScheduleNotFoundError extends Error {
  override readonly name = 'ScheduleNotFoundError';
}

interface ScheduleRow {
  id: string;
  tenant_id: string;
  label: string;
  timezone: string;
  rules: unknown;
  holidays: unknown;
}

/** MariaDB's `json` columns come back parsed or as a string depending on the driver. */
function parseJson<T>(value: unknown): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : (value as T);
}

function toSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    label: row.label,
    timezone: row.timezone,
    rules: parseJson<ScheduleRule[]>(row.rules),
    holidays: parseJson<ScheduleHoliday[]>(row.holidays),
  };
}

/**
 * Data access for schedules (S3-08; 05 §3.3). Every query goes through
 * `scoped(ctx)` (CLAUDE.md rule 2), and each change publishes a thin
 * `pbx.schedule.*` event through the outbox (rule 6).
 */
export function createScheduleRepo(db: Database<PbxConfigServiceDb>) {
  function actorOf(ctx: DbContext) {
    return ctx.actorId === undefined || ctx.orgId === undefined
      ? {}
      : { actor: { type: 'user' as const, id: ctx.actorId, orgId: ctx.orgId } };
  }

  return {
    list: (ctx: DbContext): Promise<Schedule[]> =>
      db
        .scoped(ctx)
        .selectFrom('schedules')
        .selectAll()
        .orderBy('label', 'asc')
        .execute()
        .then((rows) => rows.map(toSchedule)),

    findById: (ctx: DbContext, id: string): Promise<Schedule | undefined> =>
      db
        .scoped(ctx)
        .selectFrom('schedules')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : toSchedule(row))),

    async create(ctx: DbContext, input: CreateScheduleInput): Promise<Schedule> {
      const { tenantId } = requireTenant(ctx);
      const label = validateLabel(input.label);
      const timezone = validateTimezone(input.timezone);
      const rules = validateRules(input.rules ?? []);
      const holidays = validateHolidays(input.holidays ?? []);
      const id = randomUUID();
      const now = new Date();

      await db.scoped(ctx).transaction(async (trx, raw) => {
        await trx
          .insertInto('schedules')
          .values({
            id,
            label,
            timezone,
            rules: JSON.stringify(rules),
            holidays: JSON.stringify(holidays),
            created_at: now,
            updated_at: now,
            version: 1,
          })
          .execute();

        await enqueueEvent(raw, pbxEvents, {
          type: 'pbx.schedule.created',
          data: { scheduleId: id },
          orgContext: { tenantId },
          ...actorOf(ctx),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });

      return { id, tenantId, label, timezone, rules, holidays };
    },

    async update(ctx: DbContext, id: string, input: UpdateScheduleInput): Promise<Schedule> {
      const { tenantId } = requireTenant(ctx);
      const existing = await db
        .scoped(ctx)
        .selectFrom('schedules')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing === undefined) throw new ScheduleNotFoundError(`No schedule with id '${id}'.`);
      const current = toSchedule(existing);

      const label = input.label === undefined ? current.label : validateLabel(input.label);
      const timezone =
        input.timezone === undefined ? current.timezone : validateTimezone(input.timezone);
      const rules = input.rules === undefined ? [...current.rules] : validateRules(input.rules);
      const holidays =
        input.holidays === undefined ? [...current.holidays] : validateHolidays(input.holidays);

      await db.scoped(ctx).transaction(async (trx, raw) => {
        await trx
          .updateTable('schedules')
          .set({
            label,
            timezone,
            rules: JSON.stringify(rules),
            holidays: JSON.stringify(holidays),
            updated_at: new Date(),
            version: existing.version + 1,
          })
          .where('id', '=', id)
          .execute();

        await enqueueEvent(raw, pbxEvents, {
          type: 'pbx.schedule.updated',
          data: { scheduleId: id },
          orgContext: { tenantId },
          ...actorOf(ctx),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });

      return { id, tenantId, label, timezone, rules, holidays };
    },

    async remove(ctx: DbContext, id: string): Promise<void> {
      const { tenantId } = requireTenant(ctx);

      await db.scoped(ctx).transaction(async (trx, raw) => {
        const result = await trx.deleteFrom('schedules').where('id', '=', id).executeTakeFirst();
        if (Number(result.numDeletedRows) === 0) {
          throw new ScheduleNotFoundError(`No schedule with id '${id}'.`);
        }

        await enqueueEvent(raw, pbxEvents, {
          type: 'pbx.schedule.deleted',
          data: { scheduleId: id },
          orgContext: { tenantId },
          ...actorOf(ctx),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });
    },
  };
}

export type ScheduleRepo = ReturnType<typeof createScheduleRepo>;
