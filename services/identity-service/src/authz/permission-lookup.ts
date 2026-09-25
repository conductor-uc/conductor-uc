import type { Grant } from '@cuc/authz';

import type { GrantRepo } from '../repo/grant.repo.js';
import type { RoleRepo } from '../repo/role.repo.js';
import type { UserRepo } from '../repo/user.repo.js';

export interface PermissionLookup {
  /**
   * What a person may do across their whole organization, for a route-level
   * check: every permission of a role assigned in their own org, plus grants
   * that cover the whole org. A grant on one extension, mailbox or queue is
   * not counted: it cannot open a route that serves the whole tenant.
   *
   * A person who is not in `orgId`, who does not exist, or who is disabled
   * holds nothing (an empty set), so a valid access token of someone disabled
   * a minute ago stops working at the next check.
   */
  ofUser(userId: string, orgId: string): Promise<ReadonlySet<string>>;

  /**
   * The detail behind {@link ofUser}, for a service that must honour a grant on
   * one extension, queue or DID (recording-service): the roles assigned in
   * `orgId` with each role's permissions, and every grant in `orgId` naming the
   * person or one of those roles, whatever its scope. `undefined` under the same
   * conditions `ofUser` answers an empty set for someone who cannot sign in.
   */
  accessOf(userId: string, orgId: string): Promise<UserAccess | undefined>;
}

export interface UserAccess {
  readonly roles: readonly { readonly id: string; readonly permissions: readonly string[] }[];
  readonly grants: readonly Grant[];
}

export function createPermissionLookup(
  users: Pick<UserRepo, 'findById'>,
  roles: Pick<RoleRepo, 'roleIdsForIn' | 'catalogFor'>,
  grants: Pick<GrantRepo, 'forPrincipal'>,
): PermissionLookup {
  async function isActiveIn(userId: string, orgId: string): Promise<boolean> {
    const user = await users.findById(userId);
    return user?.orgId === orgId && user.status === 'active';
  }

  return {
    async accessOf(userId, orgId) {
      if (!(await isActiveIn(userId, orgId))) return undefined;

      const roleIds = await roles.roleIdsForIn(userId, orgId);
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

    async ofUser(userId, orgId) {
      if (!(await isActiveIn(userId, orgId))) return new Set();

      const roleIds = await roles.roleIdsForIn(userId, orgId);
      const catalog = await roles.catalogFor(orgId);
      const held = new Set<string>();
      for (const roleId of roleIds) {
        for (const permission of catalog.get(roleId)?.permissions ?? []) held.add(permission);
      }
      for (const grant of await grants.forPrincipal(userId, roleIds)) {
        if (grant.scope.type === 'org' && grant.scope.id === orgId) held.add(grant.permission);
      }
      return held;
    },
  };
}
