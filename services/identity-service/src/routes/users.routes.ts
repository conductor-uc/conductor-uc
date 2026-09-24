import { ProblemError, Type, type Server } from '@cuc/http';

import type { RoleRepo } from '../repo/role.repo.js';
import type { UserRepo } from '../repo/user.repo.js';

const OrgParamsSchema = Type.Object({ orgId: Type.String({ minLength: 1 }) });
const UserParamsSchema = Type.Object({
  orgId: Type.String({ minLength: 1 }),
  userId: Type.String({ minLength: 1 }),
});

const StatusSchema = Type.Union([Type.Literal('active'), Type.Literal('disabled')]);

const UserSchema = Type.Object({
  id: Type.String(),
  email: Type.String(),
  displayName: Type.String(),
  status: StatusSchema,
  mfaEnrolled: Type.Boolean(),
  lastLoginAt: Type.Union([Type.String(), Type.Null()]),
  roleIds: Type.Array(Type.String()),
});

const UpdateUserBodySchema = Type.Object({
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  status: Type.Optional(StatusSchema),
});

/**
 * `/v1/orgs/{orgId}/users` (S3-08; 06): who is in the org, and renaming or
 * disabling them. New people arrive by invitation (`POST .../invitations`),
 * and roles are assigned through `.../roles/{roleId}/assignments`.
 *
 * Own org only, for the reason invitations are (G-56): identity-service holds
 * no org read model, so it cannot tell whether another org id is one the
 * caller may manage. A user cannot be deleted from here; disabling ends their
 * sessions and stops them signing in, and keeps the record that audit trails
 * point at.
 */
export function registerUserRoutes(app: Server, users: UserRepo, roles: RoleRepo): void {
  function ownOrg(request: {
    context: { orgId?: string | undefined };
    params: { orgId: string };
  }): string {
    const own = request.context.orgId;
    if (own === undefined) throw ProblemError.unauthorized('Sign in to manage users.');
    if (request.params.orgId !== own) {
      throw ProblemError.forbidden('You can only manage users in your own organization.', {
        code: 'users_other_org',
      });
    }
    return own;
  }

  app.get(
    '/v1/orgs/:orgId/users',
    {
      config: { permission: 'user.manage', dataClass: 'config' },
      schema: {
        params: OrgParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(UserSchema) }) },
      },
    },
    async (request) => {
      const orgId = ownOrg(request);
      const [rows, roleIds] = await Promise.all([
        users.listByOrg(orgId),
        roles.roleIdsByUserIn(orgId),
      ]);
      return {
        rows: rows.map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          status: u.status,
          mfaEnrolled: u.mfaEnrolled,
          lastLoginAt: u.lastLoginAt === null ? null : u.lastLoginAt.toISOString(),
          roleIds: roleIds.get(u.id) ?? [],
        })),
      };
    },
  );

  app.patch(
    '/v1/orgs/:orgId/users/:userId',
    {
      config: { permission: 'user.manage', dataClass: 'config' },
      schema: {
        params: UserParamsSchema,
        body: UpdateUserBodySchema,
        response: { 200: UserSchema },
      },
    },
    async (request) => {
      const orgId = ownOrg(request);
      const { userId } = request.params;
      if (request.body.status === 'disabled' && userId === request.context.actorId) {
        throw ProblemError.conflict('You cannot disable your own account.', {
          code: 'cannot_disable_self',
        });
      }
      const updated = await users.update(request.context, orgId, userId, request.body);
      if (updated === undefined) throw ProblemError.notFound('No such user in this organization.');
      const roleIds = await roles.roleIdsByUserIn(orgId);
      return {
        id: updated.id,
        email: updated.email,
        displayName: updated.displayName,
        status: updated.status,
        mfaEnrolled: updated.mfaEnrolled,
        lastLoginAt: updated.lastLoginAt === null ? null : updated.lastLoginAt.toISOString(),
        roleIds: roleIds.get(userId) ?? [],
      };
    },
  );
}
