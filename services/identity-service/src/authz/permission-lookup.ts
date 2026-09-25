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
}

export function createPermissionLookup(
  users: Pick<UserRepo, 'findById'>,
  roles: Pick<RoleRepo, 'roleIdsForIn' | 'catalogFor'>,
  grants: Pick<GrantRepo, 'forPrincipal'>,
): PermissionLookup {
  return {
    async ofUser(userId, orgId) {
      const user = await users.findById(userId);
      if (user?.orgId !== orgId || user.status !== 'active') return new Set();

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
