import { secretEquals } from '@cuc/crypto';
import type { DbContext } from '@cuc/db';
import { ProblemError, Type, type Server } from '@cuc/http';

import { InvalidPickupGroupError, pickupPeers } from '../domain/pickup-group.js';
import type { ExtensionRepo } from '../repo/extension.repo.js';
import {
  PickupGroupMemberNotFoundError,
  PickupGroupNotFoundError,
  type PickupGroup,
  type PickupGroupRepo,
} from '../repo/pickup-group.repo.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });
const ParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});

const PickupGroupSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  memberExtensionIds: Type.Array(Type.String()),
});

const CreateBodySchema = Type.Object({
  label: Type.String({ minLength: 1 }),
  memberExtensionIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 2 }),
});
const UpdateBodySchema = Type.Object({
  label: Type.Optional(Type.String({ minLength: 1 })),
  memberExtensionIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 2 })),
});

function toResponse(group: PickupGroup) {
  return {
    id: group.id,
    label: group.label,
    memberExtensionIds: [...group.memberExtensionIds],
  };
}

function ctxFor(request: {
  readonly context: DbContext;
  readonly params: { readonly tenantId: string };
}): DbContext {
  return { ...request.context, tenantId: request.params.tenantId };
}

function toProblem(error: unknown): ProblemError {
  if (error instanceof InvalidPickupGroupError) {
    return ProblemError.badRequest(error.message, { code: 'invalid_pickup_group' });
  }
  if (error instanceof PickupGroupNotFoundError) {
    return ProblemError.notFound(error.message, { code: 'pickup_group_not_found' });
  }
  if (error instanceof PickupGroupMemberNotFoundError) {
    return ProblemError.badRequest(error.message, {
      code: 'pickup_group_member_not_found',
      params: error.params,
    });
  }
  throw error;
}

/**
 * `/v1/tenants/{tenantId}/pickup-groups` (S9-18, G-125): who may pick up whose ringing calls.
 * Configuration, so `group.read`/`group.manage` like ring groups.
 */
export function registerPickupGroupRoutes(app: Server, pickupGroups: PickupGroupRepo): void {
  app.get(
    '/v1/tenants/:tenantId/pickup-groups',
    {
      config: { permission: 'group.read', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(PickupGroupSchema) }) },
      },
    },
    async (request) => ({
      rows: (await pickupGroups.list(ctxFor(request))).map(toResponse),
    }),
  );

  app.get(
    '/v1/tenants/:tenantId/pickup-groups/:id',
    {
      config: { permission: 'group.read', dataClass: 'config' },
      schema: { params: ParamsSchema, response: { 200: PickupGroupSchema } },
    },
    async (request) => {
      const found = await pickupGroups.findById(ctxFor(request), request.params.id);
      if (found === undefined) {
        throw ProblemError.notFound('No pickup group with that id.', {
          code: 'pickup_group_not_found',
        });
      }
      return toResponse(found);
    },
  );

  app.post(
    '/v1/tenants/:tenantId/pickup-groups',
    {
      config: { permission: 'group.manage', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        body: CreateBodySchema,
        response: { 201: PickupGroupSchema },
      },
    },
    async (request, reply) => {
      try {
        const created = await pickupGroups.create(ctxFor(request), request.body);
        return reply.status(201).send(toResponse(created));
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.patch(
    '/v1/tenants/:tenantId/pickup-groups/:id',
    {
      config: { permission: 'group.manage', dataClass: 'config' },
      schema: {
        params: ParamsSchema,
        body: UpdateBodySchema,
        response: { 200: PickupGroupSchema },
      },
    },
    async (request) => {
      try {
        return toResponse(
          await pickupGroups.update(ctxFor(request), request.params.id, request.body),
        );
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/pickup-groups/:id',
    {
      config: { permission: 'group.manage', dataClass: 'config' },
      schema: { params: ParamsSchema },
    },
    async (request, reply) => {
      try {
        await pickupGroups.remove(ctxFor(request), request.params.id);
      } catch (error) {
        throw toProblem(error);
      }
      return reply.status(204).send();
    },
  );
}

/**
 * `GET /internal/v1/tenants/{t}/extensions/by-number/{number}/pickup-peers` (S9-18, service
 * token): the numbers of the extensions [number] may pick up, for call-control, which knows live
 * legs only by the extension number the node vouched for. An unknown extension has none.
 */
export function registerPickupPeersInternalRoutes(
  app: Server,
  deps: {
    readonly pickupGroups: PickupGroupRepo;
    readonly extensions: ExtensionRepo;
    readonly internalServiceToken: string;
  },
): void {
  const { pickupGroups, extensions } = deps;
  app.get(
    '/internal/v1/tenants/:tenantId/extensions/by-number/:number/pickup-peers',
    {
      config: { public: true },
      schema: {
        params: Type.Object({
          tenantId: Type.String({ minLength: 1 }),
          number: Type.String({ minLength: 1, maxLength: 16, pattern: '^[0-9]+$' }),
        }),
        response: { 200: Type.Object({ numbers: Type.Array(Type.String()) }) },
      },
    },
    async (request) => {
      const [scheme, presented] = request.headers.authorization?.split(' ') ?? [];
      if (
        scheme !== 'Bearer' ||
        presented === undefined ||
        !secretEquals(deps.internalServiceToken, presented)
      ) {
        throw ProblemError.unauthorized('A valid internal service token is required.', {
          code: 'internal_token_invalid',
        });
      }
      const ctx = { tenantId: request.params.tenantId };
      const own = await extensions.findByNumber(ctx, request.params.number);
      if (own === undefined) return { numbers: [] };
      const peers = new Set(pickupPeers(own.id, await pickupGroups.list(ctx)));
      if (peers.size === 0) return { numbers: [] };
      // A member deleted since it was added is simply not there any more.
      const numbers = (await extensions.list(ctx))
        .filter((extension) => peers.has(extension.id))
        .map((extension) => extension.number)
        .sort();
      return { numbers };
    },
  );
}
