import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server } from '@cuc/http';

import type { GrantRepo } from '../repo/grant.repo.js';
import type { RoleRepo } from '../repo/role.repo.js';

const AccessParamsSchema = Type.Object({
  orgId: Type.String({ minLength: 1 }),
  userId: Type.String({ minLength: 1 }),
});

const AccessSchema = Type.Object({
  roles: Type.Array(Type.Object({ id: Type.String(), permissions: Type.Array(Type.String()) })),
  grants: Type.Array(
    Type.Object({
      principalType: Type.Union([Type.Literal('user'), Type.Literal('role')]),
      principalId: Type.String(),
      permission: Type.String(),
      scope: Type.Object({ type: Type.String(), id: Type.String() }),
    }),
  ),
});

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token !== undefined && token !== '' ? token : undefined;
}

/**
 * `GET /internal/v1/orgs/:orgId/users/:userId/access`: the roles a user holds (with each role's
 * permissions, built-in and the org's custom ones) and every grant naming them or one of those
 * roles, in the shape `@cuc/authz`'s `allowed()` takes.
 *
 * Access tokens carry no roles (G-56) and `/me` only summarises permissions for the console
 * (G-91), so a service that must honour a *scoped* grant per request asks here. The first is
 * recording-service (`recording.listen` on `queue:Q1`). Gated by the shared internal token, like
 * this service's other internal route.
 */
export function registerAccessRoutes(
  app: Server,
  roles: RoleRepo,
  grants: GrantRepo,
  internalServiceToken: string,
): void {
  app.get(
    '/internal/v1/orgs/:orgId/users/:userId/access',
    {
      config: { public: true },
      schema: { params: AccessParamsSchema, response: { 200: AccessSchema } },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }

      const { orgId, userId } = request.params;
      const roleIds = await roles.roleIdsFor(userId);
      const catalog = await roles.catalogFor(orgId);
      const held = roleIds.flatMap((id) => {
        const role = catalog.get(id);
        return role === undefined ? [] : [{ id, permissions: [...role.permissions].sort() }];
      });
      const relevant = (await grants.forPrincipal(userId, roleIds))
        .filter((grant) => grant.orgId === orgId)
        .map((grant) => ({
          principalType: grant.principalType,
          principalId: grant.principalId,
          permission: grant.permission,
          scope: grant.scope,
        }));
      return { roles: held, grants: relevant };
    },
  );
}
