import { BUILT_IN_ROLES, isBuiltInRoleId, isKnownPermission } from '@cuc/authz';
import { ProblemError, Type, type Server } from '@cuc/http';

import { type ActorContext, type ManagedOrg, type OrgAccess } from '../authz/org-access.js';
import type { PermissionLookup } from '../authz/permission-lookup.js';
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
  lookup: PermissionLookup,
): void {
  /** The org the request names, once the actor is known to be allowed to manage it. */
  async function managedOrgOf(request: {
    context: ActorContext;
    params: { orgId: string };
  }): Promise<ManagedOrg> {
    return access.resolve(request.context, request.params.orgId);
  }
  async function managedOrg(request: {
    context: ActorContext;
    params: { orgId: string };
  }): Promise<string> {
    return (await managedOrgOf(request)).orgId;
  }

  /**
   * Nobody hands out what they do not hold: a custom role may carry only
   * permissions the person creating it has (the master holds every one). A
   * name that is not in the catalog is refused too, since it could never be
   * checked against anything.
   */
  async function assertHoldsAll(
    context: ActorContext & { actorId?: string | undefined },
    permissions: readonly string[],
  ): Promise<void> {
    const { actorId, orgId } = context;
    if (actorId === undefined || orgId === undefined) {
      throw ProblemError.unauthorized('Sign in to manage roles.');
    }
    const unknown = permissions.find((p) => !isKnownPermission(p));
    if (unknown !== undefined) {
      throw ProblemError.badRequest(`'${unknown}' is not a permission.`, {
        code: 'unknown_permission',
      });
    }
    const held = await lookup.ofUser(actorId, orgId);
    const missing = permissions.find((p) => !held.has(p));
    if (missing !== undefined) {
      throw ProblemError.forbidden('You cannot give a role a permission you do not hold.', {
        code: 'permission_escalation',
      });
    }
  }

  /**
   * Which roles may be assigned where. A built-in role belongs to one tier
   * (`master_*`, `reseller_*`, `tenant_*`) and can be assigned only inside an
   * org of that tier, so a tenant admin cannot make anyone a master admin; a
   * custom role only inside the org that defined it.
   */
  async function assertAssignable(roleId: string, org: ManagedOrg): Promise<void> {
    if (isBuiltInRoleId(roleId)) {
      if (!roleId.startsWith(`${org.type}_`)) {
        throw ProblemError.forbidden(`'${roleId}' cannot be assigned inside this organization.`, {
          code: 'role_wrong_tier',
        });
      }
      return;
    }
    if (!(await roles.listCustomRoles(org.orgId)).some((role) => role.id === roleId)) {
      throw ProblemError.notFound('No such role in this organization.');
    }
  }

  /** Nobody changes their own roles: that is how a person would raise (or, by mistake, lose) their own access. */
  function assertNotSelf(actorId: string | undefined, userId: string): void {
    if (actorId === userId) {
      throw ProblemError.forbidden('You cannot change your own roles.', {
        code: 'cannot_change_own_roles',
      });
    }
  }

  /** Assigning or revoking a role reaches only people who belong to the org. */
  async function memberOf(orgId: string, userId: string): Promise<void> {
    const user = await users.findById(userId);
    if (user?.orgId !== orgId) throw ProblemError.notFound('No such user in this organization.');
  }

  app.get(
    '/v1/orgs/:orgId/roles',
    {
      config: { permission: 'role.read', dataClass: 'config' },
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
      await assertHoldsAll(request.context, request.body.permissions);
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
      const org = await managedOrgOf(request);
      const orgId = org.orgId;
      assertNotSelf(request.context.actorId, request.body.userId);
      await memberOf(orgId, request.body.userId);
      await assertAssignable(request.params.roleId, org);
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
      assertNotSelf(request.context.actorId, request.body.userId);
      await memberOf(orgId, request.body.userId);
      await roles.revokeRole(request.body.userId, request.params.roleId, orgId);
      return reply.status(204).send();
    },
  );
}
