import type { DbContext } from '@cuc/db';
import { ProblemError, Type, type Server, type Static } from '@cuc/http';

import { InvalidRingGroupError } from '../domain/ring-group.js';
import {
  RingGroupMemberNotFoundError,
  RingGroupNotFoundError,
  type RingGroupRepo,
} from '../repo/ring-group.repo.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });
const RingGroupParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});

const RingGroupSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  strategy: Type.String(),
  memberExtensionIds: Type.Array(Type.String()),
  ringTimeoutSeconds: Type.Number(),
  noAnswerDestinationType: Type.Union([Type.String(), Type.Null()]),
  noAnswerDestinationId: Type.Union([Type.String(), Type.Null()]),
});
type RingGroupResponse = Static<typeof RingGroupSchema>;

const CreateRingGroupBodySchema = Type.Object({
  label: Type.String({ minLength: 1 }),
  strategy: Type.String({ minLength: 1 }),
  memberExtensionIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  ringTimeoutSeconds: Type.Number(),
  noAnswerDestinationType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  noAnswerDestinationId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const UpdateRingGroupBodySchema = Type.Object({
  label: Type.Optional(Type.String({ minLength: 1 })),
  strategy: Type.Optional(Type.String({ minLength: 1 })),
  memberExtensionIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
  ringTimeoutSeconds: Type.Optional(Type.Number()),
  noAnswerDestinationType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  noAnswerDestinationId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

function toResponse(group: {
  id: string;
  label: string;
  strategy: string;
  memberExtensionIds: readonly string[];
  ringTimeoutSeconds: number;
  noAnswerDestinationType: string | null;
  noAnswerDestinationId: string | null;
}): RingGroupResponse {
  return { ...group, memberExtensionIds: [...group.memberExtensionIds] };
}

function ctxFor(request: {
  readonly context: DbContext;
  readonly params: { readonly tenantId: string };
}): DbContext {
  return { ...request.context, tenantId: request.params.tenantId };
}

function toProblem(error: unknown): ProblemError {
  if (error instanceof InvalidRingGroupError) return ProblemError.badRequest(error.message);
  if (error instanceof RingGroupNotFoundError) return ProblemError.notFound(error.message);
  if (error instanceof RingGroupMemberNotFoundError) return ProblemError.badRequest(error.message);
  throw error;
}

/**
 * Registers `/v1/tenants/{tenantId}/ring-groups` (S2-08; 05 §3.3).
 * `group.manage` was already in the permission catalog (07 §3.3's own
 * original table, seeded ahead of this feature — same near-miss S2-07's
 * `media.manage` already flagged: check the catalog before inventing a
 * permission string).
 */
export function registerRingGroupRoutes(app: Server, ringGroups: RingGroupRepo): void {
  app.get(
    '/v1/tenants/:tenantId/ring-groups',
    {
      config: { permission: 'group.manage', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(RingGroupSchema) }) },
      },
    },
    async (request) => ({ rows: (await ringGroups.list(ctxFor(request))).map(toResponse) }),
  );

  app.get(
    '/v1/tenants/:tenantId/ring-groups/:id',
    {
      config: { permission: 'group.manage', dataClass: 'config' },
      schema: { params: RingGroupParamsSchema, response: { 200: RingGroupSchema } },
    },
    async (request) => {
      const found = await ringGroups.findById(ctxFor(request), request.params.id);
      if (found === undefined) throw ProblemError.notFound('No ring group with that id.');
      return toResponse(found);
    },
  );

  app.post(
    '/v1/tenants/:tenantId/ring-groups',
    {
      config: { permission: 'group.manage', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        body: CreateRingGroupBodySchema,
        response: { 201: RingGroupSchema },
      },
    },
    async (request, reply) => {
      try {
        const created = await ringGroups.create(ctxFor(request), request.body);
        return reply.status(201).send(toResponse(created));
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.patch(
    '/v1/tenants/:tenantId/ring-groups/:id',
    {
      config: { permission: 'group.manage', dataClass: 'config' },
      schema: {
        params: RingGroupParamsSchema,
        body: UpdateRingGroupBodySchema,
        response: { 200: RingGroupSchema },
      },
    },
    async (request) => {
      try {
        return toResponse(
          await ringGroups.update(ctxFor(request), request.params.id, request.body),
        );
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/ring-groups/:id',
    {
      config: { permission: 'group.manage', dataClass: 'config' },
      schema: { params: RingGroupParamsSchema },
    },
    async (request, reply) => {
      try {
        await ringGroups.remove(ctxFor(request), request.params.id);
      } catch (error) {
        throw toProblem(error);
      }
      return reply.status(204).send();
    },
  );
}
