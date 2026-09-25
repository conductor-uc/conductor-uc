import { randomUUID } from 'node:crypto';

import {
  isBuiltInRoleId,
  roleCatalog,
  type Permission,
  type Role,
  type RoleCatalog,
} from '@cuc/authz';
import type { Database } from '@cuc/db';
import { isDuplicateKeyError } from '@cuc/db';

import type { IdentityServiceDb } from '../schema.js';

export class RoleNameTakenError extends Error {
  override readonly name = 'RoleNameTakenError';

  constructor(name: string) {
    super(`A role named '${name}' already exists in this org.`);
  }
}

export class BuiltInRoleIdError extends Error {
  override readonly name = 'BuiltInRoleIdError';

  constructor(id: string) {
    super(
      `'${id}' is a built-in role id (@cuc/authz) and cannot be assigned as a custom role's id.`,
    );
  }
}

export interface CustomRoleSummary {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly permissions: readonly Permission[];
}

/**
 * Data access for custom roles and role assignments.
 *
 * Neither table is tenant-owned in the `@cuc/db` sense — `roles.org_id` can
 * name a master, reseller, or tenant org — so, as with every other table in
 * this service, queries filter by an explicit org id rather than going
 * through `scoped(ctx)`.
 */
export function createRoleRepo(db: Database<IdentityServiceDb>) {
  const kysely = db.kysely;

  return {
    /** Custom roles defined by `orgId`. Built-ins are `@cuc/authz` data, not rows here. */
    async listCustomRoles(orgId: string): Promise<CustomRoleSummary[]> {
      const roles = await kysely
        .selectFrom('roles')
        .selectAll()
        .where('org_id', '=', orgId)
        .execute();
      if (roles.length === 0) return [];

      const roleIds = roles.map((role) => role.id);
      const permissionRows = await kysely
        .selectFrom('role_permissions')
        .selectAll()
        .where('role_id', 'in', roleIds)
        .execute();

      return roles.map((role) => ({
        id: role.id,
        orgId: role.org_id,
        name: role.name,
        permissions: permissionRows
          .filter((row) => row.role_id === role.id)
          .map((row) => row.permission),
      }));
    },

    /**
     * Creates a custom role and its permission bundle in one transaction — a
     * role with no permissions row would be indistinguishable from one whose
     * insert half-completed, so both commit or neither does.
     */
    async createCustomRole(
      orgId: string,
      name: string,
      permissions: readonly Permission[],
    ): Promise<CustomRoleSummary> {
      const id = randomUUID();

      try {
        await kysely.transaction().execute(async (trx) => {
          await trx
            .insertInto('roles')
            .values({ id, org_id: orgId, name, created_at: new Date() })
            .execute();
          if (permissions.length > 0) {
            await trx
              .insertInto('role_permissions')
              .values(permissions.map((permission) => ({ role_id: id, permission })))
              .execute();
          }
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) throw new RoleNameTakenError(name);
        throw error;
      }

      return { id, orgId, name, permissions };
    },

    /**
     * Assigns a role — built-in or custom — to a user, scoped to one org.
     * `roleId` is not validated against `roles` here: most assignments name a
     * built-in id, which is code, not a row (see `schema.ts`).
     */
    async assignRole(userId: string, roleId: string, scopeOrgId: string): Promise<void> {
      try {
        await kysely
          .insertInto('role_assignments')
          .values({ user_id: userId, role_id: roleId, scope_org_id: scopeOrgId })
          .execute();
      } catch (error) {
        // Already assigned: idempotent, not an error.
        if (!isDuplicateKeyError(error)) throw error;
      }
    },

    async revokeRole(userId: string, roleId: string, scopeOrgId: string): Promise<void> {
      await kysely
        .deleteFrom('role_assignments')
        .where('user_id', '=', userId)
        .where('role_id', '=', roleId)
        .where('scope_org_id', '=', scopeOrgId)
        .execute();
    },

    /** The role ids held in one org, by user id, for the users screen. */
    async roleIdsByUserIn(scopeOrgId: string): Promise<Map<string, string[]>> {
      const rows = await kysely
        .selectFrom('role_assignments')
        .select(['user_id', 'role_id'])
        .where('scope_org_id', '=', scopeOrgId)
        .execute();
      const byUser = new Map<string, string[]>();
      for (const row of rows) {
        byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row.role_id]);
      }
      return byUser;
    },

    /** Every role id assigned to `userId`, in any scope. What `Actor.roleIds` is built from. */
    async roleIdsFor(userId: string): Promise<string[]> {
      const rows = await kysely
        .selectFrom('role_assignments')
        .select(['role_id'])
        .where('user_id', '=', userId)
        .execute();
      return rows.map((row) => row.role_id);
    },

    /** The role ids `userId` holds through assignments scoped to `scopeOrgId`: what a route-level permission check counts. */
    async roleIdsForIn(userId: string, scopeOrgId: string): Promise<string[]> {
      const rows = await kysely
        .selectFrom('role_assignments')
        .select(['role_id'])
        .where('user_id', '=', userId)
        .where('scope_org_id', '=', scopeOrgId)
        .execute();
      return rows.map((row) => row.role_id);
    },

    /** The merged catalog (built-ins + this org's custom roles) `@cuc/authz` evaluates against. */
    async catalogFor(orgId: string): Promise<RoleCatalog> {
      const custom = await this.listCustomRoles(orgId);
      const roles: Role[] = custom.map((role) => ({
        id: role.id,
        permissions: new Set(role.permissions),
      }));
      return roleCatalog(roles);
    },
  };
}

export type RoleRepo = ReturnType<typeof createRoleRepo>;

export { isBuiltInRoleId };
