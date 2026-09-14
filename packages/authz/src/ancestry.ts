import type { OrgRef } from './types.js';

/**
 * Org ancestry (07 §3.1): an actor may act on its own org or on descendants.
 * Master is an ancestor of everything; a reseller is an ancestor of its own
 * tenants only; a tenant is an ancestor of nothing but itself.
 */
export function orgAncestry(actorOrg: OrgRef, resourceOrg: OrgRef): boolean {
  if (actorOrg.type === 'master') return true;
  if (actorOrg.id === resourceOrg.id) return true;
  if (actorOrg.type === 'reseller') return resourceOrg.resellerId === actorOrg.id;
  return false;
}
