import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server } from '@cuc/http';

import { isScheduleOpen } from '../domain/schedule.js';
import type { ScheduleRepo } from '../repo/schedule.repo.js';

const ParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});

const QuerySchema = Type.Object({
  /** An instant to evaluate at instead of now, for tests and support ("was it open then?"). */
  at: Type.Optional(Type.String({ format: 'date-time' })),
});

const StateSchema = Type.Object({ open: Type.Boolean(), evaluatedAt: Type.String() });

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' ? token : undefined;
}

/**
 * `GET /internal/v1/tenants/:tenantId/schedules/:id/open` (S3-10, G-59): whether
 * a schedule is open right now. A call flow's `time_condition` asks this on
 * every call (through telephony-config), so editing a schedule's hours or
 * holidays takes effect on the next call with nothing republished, and the
 * one place that knows how a schedule is read is the service that owns it.
 * Service-token authenticated, like this service's other internal routes.
 */
export function registerScheduleInternalRoutes(
  app: Server,
  schedules: ScheduleRepo,
  internalServiceToken: string,
): void {
  app.get(
    '/internal/v1/tenants/:tenantId/schedules/:id/open',
    {
      config: { public: true },
      schema: { params: ParamsSchema, querystring: QuerySchema, response: { 200: StateSchema } },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }
      const { tenantId, id } = request.params;
      const schedule = await schedules.findById({ tenantId }, id);
      if (schedule === undefined) {
        throw ProblemError.notFound('No schedule with that id in that tenant.');
      }
      const at = request.query.at === undefined ? new Date() : new Date(request.query.at);
      return { open: isScheduleOpen(schedule, at), evaluatedAt: at.toISOString() };
    },
  );
}
