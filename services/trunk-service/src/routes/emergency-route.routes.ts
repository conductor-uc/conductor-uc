import type { DbContext } from '@cuc/db';
import { ProblemError, Type, type Server, type Static } from '@cuc/http';

import { InvalidEmergencyRouteError } from '../domain/emergency-route.js';
import {
  EmergencyRouteNotFoundError,
  type EmergencyRouteRepo,
} from '../repo/emergency-route.repo.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });

const EmergencyRouteSchema = Type.Object({
  id: Type.String(),
  trunkId: Type.String(),
  numbers: Type.Array(Type.String()),
});
type EmergencyRouteResponse = Static<typeof EmergencyRouteSchema>;

const UpsertEmergencyRouteBodySchema = Type.Object({
  trunkId: Type.String({ minLength: 1 }),
  numbers: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});

function toResponse(route: {
  id: string;
  trunkId: string;
  numbers: readonly string[];
}): EmergencyRouteResponse {
  return { id: route.id, trunkId: route.trunkId, numbers: [...route.numbers] };
}

function ctxFor(request: {
  readonly context: DbContext;
  readonly params: { readonly tenantId: string };
}): DbContext {
  return { ...request.context, tenantId: request.params.tenantId };
}

function toProblem(error: unknown): ProblemError {
  if (error instanceof InvalidEmergencyRouteError) return ProblemError.badRequest(error.message);
  if (error instanceof EmergencyRouteNotFoundError) return ProblemError.notFound(error.message);
  throw error;
}

/**
 * Registers `/v1/tenants/{tenantId}/emergency-route` (S2-06; 06's
 * trunk-service section; G-1) — singular, not `/emergency-routes`: one per
 * tenant (`emergency-route.repo.ts`'s own doc comment on why), so there is
 * no list/create-many/id-scoped-update the way `outbound-routes` has, just
 * get/upsert/delete on the tenant's own single route. Its own dedicated
 * `emergency_route.manage` permission, not `outbound-routes`' own
 * `trunk.manage` — G-1's compliance obligation (07 §-security doc: "the
 * reseller carries the compliance obligation") is a distinct grant from
 * ordinary trunk configuration, even though both are tenant admin/reseller
 * admin permissions today (`packages/authz/src/roles.ts`).
 */
export function registerEmergencyRouteRoutes(app: Server, routes: EmergencyRouteRepo): void {
  app.get(
    '/v1/tenants/:tenantId/emergency-route',
    {
      config: { permission: 'emergency_route.manage', dataClass: 'config' },
      schema: { params: TenantParamsSchema, response: { 200: EmergencyRouteSchema } },
    },
    async (request) => {
      const found = await routes.find(ctxFor(request));
      if (found === undefined) throw ProblemError.notFound('No emergency route for this tenant.');
      return toResponse(found);
    },
  );

  app.put(
    '/v1/tenants/:tenantId/emergency-route',
    {
      config: { permission: 'emergency_route.manage', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        body: UpsertEmergencyRouteBodySchema,
        response: { 200: EmergencyRouteSchema },
      },
    },
    async (request) => {
      try {
        return toResponse(await routes.upsert(ctxFor(request), request.body));
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/emergency-route',
    {
      config: { permission: 'emergency_route.manage', dataClass: 'config' },
      schema: { params: TenantParamsSchema },
    },
    async (request, reply) => {
      try {
        await routes.remove(ctxFor(request));
      } catch (error) {
        throw toProblem(error);
      }
      return reply.status(204).send();
    },
  );
}
