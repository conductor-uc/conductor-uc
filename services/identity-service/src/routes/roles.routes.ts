import { BUILT_IN_ROLES } from '@cuc/authz';
import { ProblemError, Type, type Server } from '@cuc/http';

import { RoleNameTakenError, type RoleRepo } from '../repo/role.repo.js';

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
export function registerRoleRoutes(app: Server, roles: RoleRepo): void {
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
      const custom = await roles.listCustomRoles(request.params.orgId);
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
      try {
        const created = await roles.createCustomRole(
          request.params.orgId,
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
      await roles.assignRole(request.body.userId, request.params.roleId, request.params.orgId);
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
      await roles.revokeRole(request.body.userId, request.params.roleId, request.params.orgId);
      return reply.status(204).send();
    },
  );
}
