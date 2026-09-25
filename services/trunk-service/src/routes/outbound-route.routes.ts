import type { DbContext } from '@cuc/db';
import { ProblemError, Type, type Server, type Static } from '@cuc/http';

import { InvalidOutboundRouteError } from '../domain/outbound-route.js';
import { OutboundRouteNotFoundError, type OutboundRouteRepo } from '../repo/outbound-route.repo.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });
const OutboundRouteParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});

const OutboundRouteSchema = Type.Object({
  id: Type.String(),
  priority: Type.Integer(),
  pattern: Type.String(),
  trunkIds: Type.Array(Type.String()),
  strip: Type.Integer(),
  prepend: Type.Union([Type.String(), Type.Null()]),
});
type OutboundRouteResponse = Static<typeof OutboundRouteSchema>;

const CreateOutboundRouteBodySchema = Type.Object({
  priority: Type.Integer({ minimum: 0 }),
  pattern: Type.String(),
  trunkIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  strip: Type.Optional(Type.Integer({ minimum: 0 })),
  prepend: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
});

const UpdateOutboundRouteBodySchema = Type.Object({
  priority: Type.Optional(Type.Integer({ minimum: 0 })),
  pattern: Type.Optional(Type.String()),
  trunkIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
  strip: Type.Optional(Type.Integer({ minimum: 0 })),
  prepend: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
});

function toResponse(route: {
  id: string;
  priority: number;
  pattern: string;
  trunkIds: readonly string[];
  strip: number;
  prepend: string | null;
}): OutboundRouteResponse {
  return {
    id: route.id,
    priority: route.priority,
    pattern: route.pattern,
    trunkIds: [...route.trunkIds],
    strip: route.strip,
    prepend: route.prepend,
  };
}

function ctxFor(request: {
  readonly context: DbContext;
  readonly params: { readonly tenantId: string };
}): DbContext {
  return { ...request.context, tenantId: request.params.tenantId };
}

function toProblem(error: unknown): ProblemError {
  if (error instanceof InvalidOutboundRouteError) return ProblemError.badRequest(error.message);
  if (error instanceof OutboundRouteNotFoundError) return ProblemError.notFound(error.message);
  throw error;
}

/**
 * Registers `/v1/tenants/{tenantId}/outbound-routes` (S2-04; 06's
 * trunk-service section). `trunk.manage` for writes and `trunk.read` for
 * reads (G-10) — the same permissions trunk CRUD itself uses, since outbound
 * routing is squarely part of a tenant's trunk configuration (05 §3.4 lists
 * this table right alongside `trunks`).
 */
export function registerOutboundRouteRoutes(app: Server, routes: OutboundRouteRepo): void {
  app.get(
    '/v1/tenants/:tenantId/outbound-routes',
    {
      config: { permission: 'trunk.read', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(OutboundRouteSchema) }) },
      },
    },
    async (request) => ({ rows: (await routes.list(ctxFor(request))).map(toResponse) }),
  );

  app.get(
    '/v1/tenants/:tenantId/outbound-routes/:id',
    {
      config: { permission: 'trunk.read', dataClass: 'config' },
      schema: { params: OutboundRouteParamsSchema, response: { 200: OutboundRouteSchema } },
    },
    async (request) => {
      const found = await routes.findById(ctxFor(request), request.params.id);
      if (found === undefined) throw ProblemError.notFound('No outbound route with that id.');
      return toResponse(found);
    },
  );

  app.post(
    '/v1/tenants/:tenantId/outbound-routes',
    {
      config: { permission: 'trunk.manage', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        body: CreateOutboundRouteBodySchema,
        response: { 201: OutboundRouteSchema },
      },
    },
    async (request, reply) => {
      try {
        const created = await routes.create(ctxFor(request), request.body);
        return reply.status(201).send(toResponse(created));
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.patch(
    '/v1/tenants/:tenantId/outbound-routes/:id',
    {
      config: { permission: 'trunk.manage', dataClass: 'config' },
      schema: {
        params: OutboundRouteParamsSchema,
        body: UpdateOutboundRouteBodySchema,
        response: { 200: OutboundRouteSchema },
      },
    },
    async (request) => {
      try {
        return toResponse(await routes.update(ctxFor(request), request.params.id, request.body));
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/outbound-routes/:id',
    {
      config: { permission: 'trunk.manage', dataClass: 'config' },
      schema: { params: OutboundRouteParamsSchema },
    },
    async (request, reply) => {
      try {
        await routes.remove(ctxFor(request), request.params.id);
      } catch (error) {
        throw toProblem(error);
      }
      return reply.status(204).send();
    },
  );
}
