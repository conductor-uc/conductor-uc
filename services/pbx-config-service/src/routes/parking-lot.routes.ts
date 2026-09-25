import type { DbContext } from '@cuc/db';
import { ProblemError, Type, type Server } from '@cuc/http';

import { InvalidParkingLotError } from '../domain/parking-lot.js';
import {
  ParkingLotNotFoundError,
  ParkingLotSlotOverlapError,
  type ParkingLotRepo,
} from '../repo/parking-lot.repo.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });
const ParkingLotParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});

const ParkingLotSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  slotStart: Type.Number(),
  slotEnd: Type.Number(),
  timeoutSeconds: Type.Number(),
  returnDestinationType: Type.Union([Type.String(), Type.Null()]),
  returnDestinationId: Type.Union([Type.String(), Type.Null()]),
});

const CreateParkingLotBodySchema = Type.Object({
  label: Type.String({ minLength: 1 }),
  slotStart: Type.Number(),
  slotEnd: Type.Number(),
  timeoutSeconds: Type.Number(),
  returnDestinationType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  returnDestinationId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const UpdateParkingLotBodySchema = Type.Object({
  label: Type.Optional(Type.String({ minLength: 1 })),
  slotStart: Type.Optional(Type.Number()),
  slotEnd: Type.Optional(Type.Number()),
  timeoutSeconds: Type.Optional(Type.Number()),
  returnDestinationType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  returnDestinationId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

function ctxFor(request: {
  readonly context: DbContext;
  readonly params: { readonly tenantId: string };
}): DbContext {
  return { ...request.context, tenantId: request.params.tenantId };
}

function toProblem(error: unknown): ProblemError {
  if (error instanceof InvalidParkingLotError) return ProblemError.badRequest(error.message);
  if (error instanceof ParkingLotNotFoundError) return ProblemError.notFound(error.message);
  if (error instanceof ParkingLotSlotOverlapError) return ProblemError.conflict(error.message);
  throw error;
}

/**
 * Registers `/v1/tenants/{tenantId}/parking-lots` (S2-14; 05 §3.3).
 * `parking_lot.manage` is a new permission (`packages/authz`'s own doc
 * comment on why — not in 07 §3.3, same precedent as `domain.manage`).
 */
export function registerParkingLotRoutes(app: Server, parkingLots: ParkingLotRepo): void {
  app.get(
    '/v1/tenants/:tenantId/parking-lots',
    {
      config: { permission: 'parking_lot.read', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(ParkingLotSchema) }) },
      },
    },
    async (request) => ({ rows: await parkingLots.list(ctxFor(request)) }),
  );

  app.get(
    '/v1/tenants/:tenantId/parking-lots/:id',
    {
      config: { permission: 'parking_lot.read', dataClass: 'config' },
      schema: { params: ParkingLotParamsSchema, response: { 200: ParkingLotSchema } },
    },
    async (request) => {
      const found = await parkingLots.findById(ctxFor(request), request.params.id);
      if (found === undefined) throw ProblemError.notFound('No parking lot with that id.');
      return found;
    },
  );

  app.post(
    '/v1/tenants/:tenantId/parking-lots',
    {
      config: { permission: 'parking_lot.manage', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        body: CreateParkingLotBodySchema,
        response: { 201: ParkingLotSchema },
      },
    },
    async (request, reply) => {
      try {
        const created = await parkingLots.create(ctxFor(request), request.body);
        return reply.status(201).send(created);
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.patch(
    '/v1/tenants/:tenantId/parking-lots/:id',
    {
      config: { permission: 'parking_lot.manage', dataClass: 'config' },
      schema: {
        params: ParkingLotParamsSchema,
        body: UpdateParkingLotBodySchema,
        response: { 200: ParkingLotSchema },
      },
    },
    async (request) => {
      try {
        return await parkingLots.update(ctxFor(request), request.params.id, request.body);
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/parking-lots/:id',
    {
      config: { permission: 'parking_lot.manage', dataClass: 'config' },
      schema: { params: ParkingLotParamsSchema },
    },
    async (request, reply) => {
      try {
        await parkingLots.remove(ctxFor(request), request.params.id);
      } catch (error) {
        throw toProblem(error);
      }
      return reply.status(204).send();
    },
  );
}
