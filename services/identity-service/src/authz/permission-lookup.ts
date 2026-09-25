import { expandPermissions, READ_TWINS, type Grant } from '@cuc/authz';

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
   *
   * The set includes what the held permissions imply (G-10): `extension.manage`
   * brings `extension.read`, so a route declaring the read twin opens for an
   * admin, or a custom role, that only names the management permission.
   */
  ofUser(userId: string, orgId: string): Promise<ReadonlySet<string>>;

  /**
   * The detail behind {@link ofUser}, for a service that must honour a grant on
   * one extension, queue or DID (recording-service): the roles assigned in
   * `orgId` with each role's permissions, and every grant in `orgId` naming the
   * person or one of those roles, whatever its scope. `undefined` under the same
   * conditions `ofUser` answers an empty set for someone who cannot sign in.
   *
   * Implied reads are spelled out here too (G-10): each role's permissions are
   * expanded, and a grant of a management permission comes with a grant of its
   * read twin on the same scope, so a caller that matches permissions exactly
   * agrees with `@cuc/authz`'s `allowed()`, which applies the implication itself.
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
        return role === undefined
          ? []
          : [{ id, permissions: [...expandPermissions(role.permissions)].sort() }];
      });
      const relevant = (await grants.forPrincipal(userId, roleIds))
        .filter((grant) => grant.orgId === orgId)
        .flatMap((grant) => {
          const base = {
            principalType: grant.principalType,
            principalId: grant.principalId,
            scope: grant.scope,
          };
          const read = Object.hasOwn(READ_TWINS, grant.permission)
            ? READ_TWINS[grant.permission]
            : undefined;
          return [
            { ...base, permission: grant.permission },
            ...(read === undefined ? [] : [{ ...base, permission: read }]),
          ];
        });
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
      return expandPermissions(held);
    },
  };
}
