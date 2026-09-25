import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server } from '@cuc/http';

import type { PermissionLookup } from '../authz/permission-lookup.js';

const ParamsSchema = Type.Object({
  orgId: Type.String({ minLength: 1 }),
  userId: Type.String({ minLength: 1 }),
});

/**
 * `GET /internal/v1/orgs/:orgId/users/:userId/permissions`: what one person may
 * do across their organization. It is how every other service learns whether
 * the signed-in person holds a route's permission (`@cuc/http`'s permission
 * guard), because access tokens carry no roles (G-56). Gated by the shared
 * internal service token like every other internal route (07 §1); the token
 * check is the gate, so the route is `public` at the route-contract level.
 *
 * Someone who does not exist, is in another org, or is disabled answers 404, so
 * the caller treats them as holding nothing.
 */
export function registerPermissionsInternalRoutes(
  app: Server,
  lookup: PermissionLookup,
  internalServiceToken: string,
): void {
  app.get(
    '/internal/v1/orgs/:orgId/users/:userId/permissions',
    {
      config: { public: true },
      schema: {
        params: ParamsSchema,
        response: { 200: Type.Object({ permissions: Type.Array(Type.String()) }) },
      },
    },
    async (request) => {
      const header = request.headers.authorization;
      const [scheme, presented] = header?.split(' ') ?? [];
      if (
        scheme !== 'Bearer' ||
        presented === undefined ||
        !secretEquals(internalServiceToken, presented)
      ) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }
      const held = await lookup.ofUser(request.params.userId, request.params.orgId);
      // Not "no permissions": a person who cannot sign in at all is not found.
      if (held.size === 0) throw ProblemError.notFound('No such active user in that organization.');
      return { permissions: [...held].sort() };
    },
  );
}
