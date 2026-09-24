import { ProblemError, Type, type Server } from '@cuc/http';

import type { GrantRepo } from '../repo/grant.repo.js';
import type { RoleRepo } from '../repo/role.repo.js';

const OrgParamsSchema = Type.Object({ orgId: Type.String({ minLength: 1 }) });

/**
 * `GET /v1/orgs/:orgId/me` (S3-05): what the signed-in user can do, so the
 * console can show only the sections and buttons they have a use for.
 *
 * Access tokens carry no roles or permissions (G-56), so the console asks.
 * The answer is every permission the user holds through any role or grant, at
 * any scope: it decides what to *show*. It is not an authorization decision
 * for a resource, which still belongs to the service that owns the resource
 * (see G-91: today no service evaluates it per request).
 *
 * Only the caller's own org may be named, and only their own permissions come
 * back, so there is nothing here to enumerate.
 */
export function registerMeRoutes(app: Server, roles: RoleRepo, grants: GrantRepo): void {
  app.get(
    '/v1/orgs/:orgId/me',
    {
      config: { permission: 'org.view', dataClass: 'config' },
      schema: {
        params: OrgParamsSchema,
        response: {
          200: Type.Object({
            userId: Type.String(),
            orgId: Type.String(),
            orgType: Type.Union([
              Type.Literal('master'),
              Type.Literal('reseller'),
              Type.Literal('tenant'),
            ]),
            roleIds: Type.Array(Type.String()),
            permissions: Type.Array(Type.String()),
          }),
        },
      },
    },
    async (request) => {
      const { actorId, orgId, orgType } = request.context;
      if (actorId === undefined || orgId === undefined || orgType === undefined) {
        throw ProblemError.unauthorized('Sign in to continue.');
      }
      if (request.params.orgId !== orgId) {
        throw ProblemError.forbidden('You can only ask about your own organization.', {
          code: 'me_other_org',
        });
      }

      const roleIds = await roles.roleIdsFor(actorId);
      const catalog = await roles.catalogFor(orgId);
      const permissions = new Set<string>();
      for (const roleId of roleIds) {
        for (const permission of catalog.get(roleId)?.permissions ?? []) {
          permissions.add(permission);
        }
      }
      for (const grant of await grants.forPrincipal(actorId, roleIds)) {
        permissions.add(grant.permission);
      }

      return { userId: actorId, orgId, orgType, roleIds, permissions: [...permissions].sort() };
    },
  );
}
