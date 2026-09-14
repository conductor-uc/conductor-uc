import { orgAncestry } from './ancestry.js';
import { hardRulesPass } from './hard-rules.js';
import { BUILT_IN_ROLES } from './roles.js';
import type { Actor, Grant, Permission, ResourceRef, RoleCatalog } from './types.js';

/** True when any role the actor holds bundles `permission` (07 §3.1). */
export function roleHas(actor: Actor, permission: Permission, roles: RoleCatalog): boolean {
  return actor.roleIds.some((roleId) => roles.get(roleId)?.permissions.has(permission) === true);
}

/**
 * True when a grant gives the actor `permission` on `resource` (07 §3.1).
 *
 * `grants` is every grant potentially relevant to consider — this function
 * does the principal filtering itself (a grant matches if it names the actor
 * directly, or names a role the actor holds), so a caller can safely pass a
 * broader list without pre-filtering it correctly first.
 */
export function grantMatches(
  actor: Actor,
  permission: Permission,
  resource: ResourceRef,
  grants: readonly Grant[],
): boolean {
  const resourceScope = resource.scope ?? { type: 'org' as const, id: resource.org.id };

  return grants.some((grant) => {
    if (grant.permission !== permission) return false;

    const principalMatches =
      (grant.principalType === 'user' && grant.principalId === actor.id) ||
      (grant.principalType === 'role' && actor.roleIds.includes(grant.principalId));
    if (!principalMatches) return false;

    // A grant scoped to the whole org covers everything in it, whatever finer
    // scope the resource itself occupies (07 §3.1).
    if (grant.scope.type === 'org' && grant.scope.id === resource.org.id) return true;
    return grant.scope.type === resourceScope.type && grant.scope.id === resourceScope.id;
  });
}

export interface AllowedInput {
  readonly actor: Actor;
  readonly permission: Permission;
  readonly resource: ResourceRef;
  /** Defaults to the built-in roles only — pass an org's merged catalog to include custom roles. */
  readonly roles?: RoleCatalog;
  /** Defaults to none. */
  readonly grants?: readonly Grant[];
}

/**
 * The authorization decision (07 §3.1):
 *
 * ```
 * allowed(actor, permission, resource) =
 *     hardRules(actor, permission, resource) != DENY
 *     AND ( orgAncestry(actor.org, resource.org)
 *           AND (roleHas(actor, permission) OR grantMatches(actor, permission, resource)) )
 * ```
 *
 * Hard rules are checked first and unconditionally: nothing below this line
 * can undo a `false` from them, which is what makes H1 (07 §3.1) actually
 * hold rather than merely be documented.
 */
export function allowed(input: AllowedInput): boolean {
  const { actor, permission, resource } = input;
  const roles = input.roles ?? BUILT_IN_ROLES;
  const grants = input.grants ?? [];

  if (!hardRulesPass(actor, permission, resource)) return false;
  if (!orgAncestry(actor.org, resource.org)) return false;

  return roleHas(actor, permission, roles) || grantMatches(actor, permission, resource, grants);
}
