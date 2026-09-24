import { ProblemError, Type, type Server } from '@cuc/http';

import { type ActorContext, type OrgAccess } from '../authz/org-access.js';
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
 * An actor manages their own org's people; the master manages anyone's, and a
 * reseller its own tenants' (G-62, through [OrgAccess]). A user cannot be
 * deleted from here; disabling ends their sessions and stops them signing in,
 * and keeps the record that audit trails point at.
 */
export function registerUserRoutes(
  app: Server,
  users: UserRepo,
  roles: RoleRepo,
  access: OrgAccess,
): void {
  async function managedOrg(request: {
    context: ActorContext;
    params: { orgId: string };
  }): Promise<string> {
    return (await access.resolve(request.context, request.params.orgId)).orgId;
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
      const orgId = await managedOrg(request);
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
      const orgId = await managedOrg(request);
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
