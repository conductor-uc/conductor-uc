import type { DbContext } from '@cuc/db';
import { ProblemError, Type, type Server } from '@cuc/http';

import { InvalidScheduleError } from '../domain/schedule.js';
import { ScheduleNotFoundError, type ScheduleRepo } from '../repo/schedule.repo.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });
const ScheduleParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});

const RuleSchema = Type.Object({
  days: Type.Array(Type.Integer({ minimum: 0, maximum: 6 })),
  start: Type.String(),
  end: Type.String(),
});
const HolidaySchema = Type.Object({
  date: Type.String(),
  label: Type.Optional(Type.String()),
});

const ScheduleSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  timezone: Type.String(),
  rules: Type.Array(RuleSchema),
  holidays: Type.Array(HolidaySchema),
});

const CreateScheduleBodySchema = Type.Object({
  label: Type.String({ minLength: 1 }),
  timezone: Type.String({ minLength: 1 }),
  rules: Type.Optional(Type.Array(RuleSchema)),
  holidays: Type.Optional(Type.Array(HolidaySchema)),
});

const UpdateScheduleBodySchema = Type.Object({
  label: Type.Optional(Type.String({ minLength: 1 })),
  timezone: Type.Optional(Type.String({ minLength: 1 })),
  rules: Type.Optional(Type.Array(RuleSchema)),
  holidays: Type.Optional(Type.Array(HolidaySchema)),
});

function ctxFor(request: {
  readonly context: DbContext;
  readonly params: { readonly tenantId: string };
}): DbContext {
  return { ...request.context, tenantId: request.params.tenantId };
}

function toProblem(error: unknown): ProblemError {
  if (error instanceof InvalidScheduleError) return ProblemError.badRequest(error.message);
  if (error instanceof ScheduleNotFoundError) return ProblemError.notFound(error.message);
  throw error;
}

/** The response typing wants mutable copies of the repo's readonly arrays. */
function toResponse(schedule: {
  id: string;
  label: string;
  timezone: string;
  rules: readonly { days: readonly number[]; start: string; end: string }[];
  holidays: readonly { date: string; label?: string }[];
}) {
  return {
    id: schedule.id,
    label: schedule.label,
    timezone: schedule.timezone,
    rules: schedule.rules.map((r) => ({ days: [...r.days], start: r.start, end: r.end })),
    holidays: schedule.holidays.map((h) => ({ ...h })),
  };
}

/**
 * Registers `/v1/tenants/{tenantId}/schedules` (S3-08; 05 §3.3). Gated by
 * `schedule.manage`, which the catalog already has.
 */
export function registerScheduleRoutes(app: Server, schedules: ScheduleRepo): void {
  app.get(
    '/v1/tenants/:tenantId/schedules',
    {
      config: { permission: 'schedule.manage', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(ScheduleSchema) }) },
      },
    },
    async (request) => ({ rows: (await schedules.list(ctxFor(request))).map(toResponse) }),
  );

  app.get(
    '/v1/tenants/:tenantId/schedules/:id',
    {
      config: { permission: 'schedule.manage', dataClass: 'config' },
      schema: { params: ScheduleParamsSchema, response: { 200: ScheduleSchema } },
    },
    async (request) => {
      const found = await schedules.findById(ctxFor(request), request.params.id);
      if (found === undefined) throw ProblemError.notFound('No schedule with that id.');
      return toResponse(found);
    },
  );

  app.post(
    '/v1/tenants/:tenantId/schedules',
    {
      config: { permission: 'schedule.manage', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        body: CreateScheduleBodySchema,
        response: { 201: ScheduleSchema },
      },
    },
    async (request, reply) => {
      try {
        const created = await schedules.create(ctxFor(request), request.body);
        return reply.status(201).send(toResponse(created));
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.patch(
    '/v1/tenants/:tenantId/schedules/:id',
    {
      config: { permission: 'schedule.manage', dataClass: 'config' },
      schema: {
        params: ScheduleParamsSchema,
        body: UpdateScheduleBodySchema,
        response: { 200: ScheduleSchema },
      },
    },
    async (request) => {
      try {
        return toResponse(await schedules.update(ctxFor(request), request.params.id, request.body));
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/schedules/:id',
    {
      config: { permission: 'schedule.manage', dataClass: 'config' },
      schema: { params: ScheduleParamsSchema },
    },
    async (request, reply) => {
      try {
        await schedules.remove(ctxFor(request), request.params.id);
      } catch (error) {
        throw toProblem(error);
      }
      return reply.status(204).send();
    },
  );
}
