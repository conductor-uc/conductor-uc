import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server } from '@cuc/http';

import type { PermissionLookup } from '../authz/permission-lookup.js';

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
 * this service's other internal routes.
 *
 * The same lookup answers `/permissions`, so the two agree on who counts: someone who does
 * not exist, is in another org, or is disabled answers 404 here too, and the caller treats
 * them as holding nothing.
 */
export function registerAccessRoutes(
  app: Server,
  lookup: Pick<PermissionLookup, 'accessOf'>,
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

      const access = await lookup.accessOf(request.params.userId, request.params.orgId);
      if (access === undefined) {
        throw ProblemError.notFound('No such active user in that organization.');
      }
      return {
        roles: access.roles.map((role) => ({ id: role.id, permissions: [...role.permissions] })),
        grants: [...access.grants],
      };
    },
  );
}
