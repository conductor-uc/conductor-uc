import { BUILT_IN_ROLES } from '@cuc/authz';
import { ProblemError, Type, type Server } from '@cuc/http';

import { type ActorContext, type OrgAccess } from '../authz/org-access.js';
import { RoleNameTakenError, type RoleRepo } from '../repo/role.repo.js';
import type { UserRepo } from '../repo/user.repo.js';

const OrgParamsSchema = Type.Object({ orgId: Type.String({ minLength: 1 }) });
const RoleParamsSchema = Type.Object({
  orgId: Type.String({ minLength: 1 }),
  roleId: Type.String({ minLength: 1 }),
});

const CreateRoleBodySchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 128 }),
  permissions: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});

const RoleSummarySchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  builtIn: Type.Boolean(),
  permissions: Type.Array(Type.String()),
});

const AssignmentBodySchema = Type.Object({ userId: Type.String({ minLength: 1 }) });

/**
 * `/v1/orgs/{orgId}/roles` (06). Built-in roles are listed alongside custom
 * ones — they are `@cuc/authz` data, not rows, but an org managing its access
 * control needs to see both to make sense of a role assignment.
 */
export function registerRoleRoutes(
  app: Server,
  roles: RoleRepo,
  access: OrgAccess,
  users: UserRepo,
): void {
  /** The org the request names, once the actor is known to be allowed to manage it. */
  async function managedOrg(request: {
    context: ActorContext;
    params: { orgId: string };
  }): Promise<string> {
    return (await access.resolve(request.context, request.params.orgId)).orgId;
  }

  /** Assigning or revoking a role reaches only people who belong to the org. */
  async function memberOf(orgId: string, userId: string): Promise<void> {
    const user = await users.findById(userId);
    if (user?.orgId !== orgId) throw ProblemError.notFound('No such user in this organization.');
  }

  app.get(
    '/v1/orgs/:orgId/roles',
    {
      config: { permission: 'role.manage', dataClass: 'config' },
      schema: {
        params: OrgParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(RoleSummarySchema) }) },
      },
    },
    async (request) => {
      const custom = await roles.listCustomRoles(await managedOrg(request));
      const builtIn = [...BUILT_IN_ROLES.values()].map((role) => ({
        id: role.id,
        name: role.id,
        builtIn: true,
        permissions: [...role.permissions],
      }));
      return {
        rows: [
          ...builtIn,
          ...custom.map((role) => ({
            ...role,
            permissions: [...role.permissions],
            builtIn: false,
          })),
        ],
      };
    },
  );

  app.post(
    '/v1/orgs/:orgId/roles',
    {
      config: { permission: 'role.manage', dataClass: 'config' },
      schema: {
        params: OrgParamsSchema,
        body: CreateRoleBodySchema,
        response: { 201: RoleSummarySchema },
      },
    },
    async (request, reply) => {
      const orgId = await managedOrg(request);
      try {
        const created = await roles.createCustomRole(
          orgId,
          request.body.name,
          request.body.permissions,
        );
        return reply
          .status(201)
          .send({ ...created, permissions: [...created.permissions], builtIn: false });
      } catch (error) {
        if (error instanceof RoleNameTakenError) {
          throw ProblemError.conflict(error.message, { code: 'role_name_taken' });
        }
        throw error;
      }
    },
  );

  app.post(
    '/v1/orgs/:orgId/roles/:roleId/assignments',
    {
      config: { permission: 'role.manage', dataClass: 'config' },
      schema: { params: RoleParamsSchema, body: AssignmentBodySchema },
    },
    async (request, reply) => {
      const orgId = await managedOrg(request);
      await memberOf(orgId, request.body.userId);
      await roles.assignRole(request.body.userId, request.params.roleId, orgId);
      return reply.status(204).send();
    },
  );

  app.delete(
    '/v1/orgs/:orgId/roles/:roleId/assignments',
    {
      config: { permission: 'role.manage', dataClass: 'config' },
      schema: { params: RoleParamsSchema, body: AssignmentBodySchema },
    },
    async (request, reply) => {
      const orgId = await managedOrg(request);
      await memberOf(orgId, request.body.userId);
      await roles.revokeRole(request.body.userId, request.params.roleId, orgId);
      return reply.status(204).send();
    },
  );
}
