import type { DbContext } from '@cuc/db';
import { ProblemError, Type, type Server } from '@cuc/http';

import { InvalidConferenceRoomError } from '../domain/conference-room.js';
import {
  ConferenceRoomNotFoundError,
  ConferenceRoomNumberTakenError,
  type ConferenceRoomRepo,
} from '../repo/conference-room.repo.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });
const ConferenceRoomParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});

const ConferenceRoomSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  number: Type.String(),
  pinRequired: Type.Boolean(),
  video: Type.Boolean(),
  layout: Type.Union([Type.String(), Type.Null()]),
  maxMembers: Type.Number(),
});

const CreateConferenceRoomBodySchema = Type.Object({
  label: Type.String({ minLength: 1 }),
  number: Type.String({ minLength: 1 }),
  pin: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  video: Type.Optional(Type.Boolean()),
  layout: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  maxMembers: Type.Number(),
});

const UpdateConferenceRoomBodySchema = Type.Object({
  label: Type.Optional(Type.String({ minLength: 1 })),
  number: Type.Optional(Type.String({ minLength: 1 })),
  pin: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  video: Type.Optional(Type.Boolean()),
  layout: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  maxMembers: Type.Optional(Type.Number()),
});

function ctxFor(request: {
  readonly context: DbContext;
  readonly params: { readonly tenantId: string };
}): DbContext {
  return { ...request.context, tenantId: request.params.tenantId };
}

function toProblem(error: unknown): ProblemError {
  if (error instanceof InvalidConferenceRoomError) return ProblemError.badRequest(error.message);
  if (error instanceof ConferenceRoomNotFoundError) return ProblemError.notFound(error.message);
  if (error instanceof ConferenceRoomNumberTakenError) return ProblemError.conflict(error.message);
  throw error;
}

/**
 * Registers `/v1/tenants/{tenantId}/conference-rooms` (S2-15; 05 §3.3).
 * `conference_room.manage` is a new permission (`packages/authz`'s own doc
 * comment on why — not in 07 §3.3, same precedent as `parking_lot.manage`).
 *
 * A room's PIN never round-trips through this API: `pin` is write-only on
 * create/update (`ConferenceRoomSchema` has no `pin` field, only the derived
 * `pinRequired` boolean) — the same "never expose the secret back" shape
 * `sip_credentials`' `:reveal`-gated route takes more explicitly, applied
 * here by simply never including it in the response schema at all.
 */
export function registerConferenceRoomRoutes(
  app: Server,
  conferenceRooms: ConferenceRoomRepo,
): void {
  app.get(
    '/v1/tenants/:tenantId/conference-rooms',
    {
      config: { permission: 'conference_room.manage', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(ConferenceRoomSchema) }) },
      },
    },
    async (request) => ({ rows: await conferenceRooms.list(ctxFor(request)) }),
  );

  app.get(
    '/v1/tenants/:tenantId/conference-rooms/:id',
    {
      config: { permission: 'conference_room.manage', dataClass: 'config' },
      schema: { params: ConferenceRoomParamsSchema, response: { 200: ConferenceRoomSchema } },
    },
    async (request) => {
      const found = await conferenceRooms.findById(ctxFor(request), request.params.id);
      if (found === undefined) throw ProblemError.notFound('No conference room with that id.');
      return found;
    },
  );

  app.post(
    '/v1/tenants/:tenantId/conference-rooms',
    {
      config: { permission: 'conference_room.manage', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        body: CreateConferenceRoomBodySchema,
        response: { 201: ConferenceRoomSchema },
      },
    },
    async (request, reply) => {
      try {
        const created = await conferenceRooms.create(ctxFor(request), request.body);
        return reply.status(201).send(created);
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.patch(
    '/v1/tenants/:tenantId/conference-rooms/:id',
    {
      config: { permission: 'conference_room.manage', dataClass: 'config' },
      schema: {
        params: ConferenceRoomParamsSchema,
        body: UpdateConferenceRoomBodySchema,
        response: { 200: ConferenceRoomSchema },
      },
    },
    async (request) => {
      try {
        return await conferenceRooms.update(ctxFor(request), request.params.id, request.body);
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/conference-rooms/:id',
    {
      config: { permission: 'conference_room.manage', dataClass: 'config' },
      schema: { params: ConferenceRoomParamsSchema },
    },
    async (request, reply) => {
      try {
        await conferenceRooms.remove(ctxFor(request), request.params.id);
      } catch (error) {
        throw toProblem(error);
      }
      return reply.status(204).send();
    },
  );
}
