import { dataClassOf } from './permissions.js';
import type { Actor, DataClass, OrgType, Permission, ResourceRef } from './types.js';

/** The permissions H4 blocks an API key from ever holding (07 §3.1). */
const API_KEY_RESTRICTED_PERMISSIONS: ReadonlySet<Permission> = new Set([
  'user.manage',
  'role.manage',
  'grant.manage',
  'apikey.manage',
]);

/** The permissions H3 reserves to the master (07 §3.1). */
const RESELLER_LIFECYCLE_PERMISSIONS: ReadonlySet<Permission> = new Set([
  'reseller.create',
  'reseller.manage',
]);

/**
 * H1, the reseller private-data wall: an actor whose org is a reseller is
 * denied any permission whose data class is `private` on a tenant resource,
 * whatever roles or grants exist (07 §3.1). This is the one hard rule
 * `@cuc/http` also enforces directly on every request, before a route handler
 * runs — see `registerHardRules` there. It is duplicated here, not imported
 * from there, because `@cuc/http` depends on `@cuc/authz` for the data-class
 * type and this evaluator; the dependency cannot run the other way.
 *
 * Every master access to a `private` resource is allowed here — it is a
 * policy decision that it be *audited* (SAD §10), not denied, and auditing is
 * `@cuc/audit`'s job, not this evaluator's.
 */
export function h1PrivateDataWall(
  actor: Actor,
  permission: Permission,
  resource: ResourceRef,
): boolean {
  return !(
    actor.org.type === 'reseller' &&
    resource.org.type === 'tenant' &&
    dataClassOf(permission) === 'private'
  );
}

/**
 * H2: tenant actors cannot access resources outside their tenant.
 *
 * For this evaluator's definition of {@link orgAncestry}, this is provably the
 * same condition ancestry alone already produces for a tenant actor — a
 * tenant is nobody's ancestor but its own. It is still checked explicitly
 * here, both because 07 §3.1 states it as its own rule and because a
 * different ancestry implementation should not silently make H2 disappear.
 */
export function h2TenantBoundary(actor: Actor, resource: ResourceRef): boolean {
  return !(actor.org.type === 'tenant' && actor.org.id !== resource.org.id);
}

/** H3: only master actors can create or modify resellers. */
export function h3ResellerLifecycle(actor: Actor, permission: Permission): boolean {
  return !(RESELLER_LIFECYCLE_PERMISSIONS.has(permission) && actor.org.type !== 'master');
}

/** H4: API keys cannot manage users, roles, grants, or other API keys. */
export function h4ApiKeyRestriction(actor: Actor, permission: Permission): boolean {
  return !(actor.type === 'apikey' && API_KEY_RESTRICTED_PERMISSIONS.has(permission));
}

/**
 * The coarse, request-scoped form of H1: `@cuc/http` runs this on every
 * request, before a route handler exists to say *which* resource is being
 * touched — it only has the actor's org type and the route's declared data
 * class, not a resource org to compare against.
 *
 * It is therefore stricter than {@link h1PrivateDataWall}: it denies a
 * reseller access to *any* private-class route, not only ones whose resource
 * turns out to be a tenant's. That is the correct direction to be wrong in
 * for a blanket, resource-unaware check — every data class the catalog marks
 * `private` (05 §3.2: CDRs, recordings, voicemail, …) is a tenant-scoped
 * concept in practice, so a reseller's own org never legitimately has
 * private-class data to begin with. A service that *does* know the resource
 * should use {@link h1PrivateDataWall} instead, which only denies when the
 * resource is actually a tenant's.
 */
export function h1RouteLevelWall(actorOrgType: OrgType, dataClass: DataClass): boolean {
  return !(actorOrgType === 'reseller' && dataClass === 'private');
}

/**
 * All four hard rules (07 §3.1), checked first and unconditionally — nothing
 * a role or a grant says can override a `false` here.
 */
export function hardRulesPass(
  actor: Actor,
  permission: Permission,
  resource: ResourceRef,
): boolean {
  return (
    h1PrivateDataWall(actor, permission, resource) &&
    h2TenantBoundary(actor, resource) &&
    h3ResellerLifecycle(actor, permission) &&
    h4ApiKeyRestriction(actor, permission)
  );
}
