import type { OrgStatus, OrgType } from '../schema.js';

/**
 * Pure business logic for the org hierarchy (09 §1: domain code should be pure
 * where possible). No DB here — `repo/org.repo.ts` is where these rules meet
 * actual rows, because the parent-type rule needs to know the parent's real
 * type, which only a read can answer.
 */

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;

export class InvalidSlugError extends Error {
  override readonly name = 'InvalidSlugError';
}

/**
 * Validates a slug: a lowercase DNS label, 2-63 characters (02 §3).
 *
 * DNS labels cannot start or end with a hyphen, which the single regex above
 * enforces along with the length bound.
 */
export function validateSlug(slug: string): string {
  if (!SLUG_PATTERN.test(slug)) {
    throw new InvalidSlugError(
      `'${slug}' is not a valid slug: 2-63 lowercase letters, digits, and hyphens, ` +
        'not starting or ending with a hyphen.',
    );
  }
  return slug;
}

export class InvalidOrgHierarchyError extends Error {
  override readonly name = 'InvalidOrgHierarchyError';
}

/**
 * The hierarchy invariant from 02 §1: a reseller's parent must be the master,
 * and a tenant's parent must be a reseller. There is no deeper nesting and no
 * tenant hangs directly under the master.
 *
 * Throws when `childType` cannot have a parent of `parentType`. The master has
 * no parent at all, which the caller enforces by never calling this for one.
 */
export function assertValidParentType(childType: OrgType, parentType: OrgType): void {
  const requiredParent: Record<Exclude<OrgType, 'master'>, OrgType> = {
    reseller: 'master',
    tenant: 'reseller',
  };

  if (childType === 'master') {
    throw new InvalidOrgHierarchyError(
      'The master org has no parent; it is created by bootstrap only.',
    );
  }

  const required = requiredParent[childType];
  if (parentType !== required) {
    throw new InvalidOrgHierarchyError(
      `A '${childType}' org's parent must be '${required}', not '${parentType}'.`,
    );
  }
}

/** The `reseller_id` a new org of `type` should be stored with. */
export function resellerIdFor(
  type: OrgType,
  parent: { readonly id: string; readonly type: OrgType },
): string | null {
  if (type !== 'tenant') return null;
  // A tenant's immediate parent is a reseller (enforced by
  // assertValidParentType before this runs), so the parent's own id is the
  // reseller_id to denormalize.
  return parent.id;
}

export class InvalidOrgStatusTransitionError extends Error {
  override readonly name = 'InvalidOrgStatusTransitionError';
}

/**
 * The lifecycle from 02 §2: `active` <-> `suspended`, and from either
 * `pending_deletion` (S1-16, G-11), which is cancellable for
 * {@link DELETION_GRACE_DAYS} days and then becomes `deleted` for good.
 */
export function assertCanSuspend(status: OrgStatus): void {
  if (status !== 'active') {
    throw new InvalidOrgStatusTransitionError(
      `Cannot suspend an org that is '${status}'; only 'active' orgs can be suspended.`,
    );
  }
}

export function assertCanResume(status: OrgStatus): void {
  if (status !== 'suspended') {
    throw new InvalidOrgStatusTransitionError(
      `Cannot resume an org that is '${status}'; only 'suspended' orgs can be resumed.`,
    );
  }
}

/** G-11: how long a deletion can be called off, and the export downloaded. */
export const DELETION_GRACE_DAYS = 30;

/** Deletion can be asked of an `active` or `suspended` org (G-11 (1)). */
export function assertCanRequestDeletion(status: OrgStatus): void {
  if (status !== 'active' && status !== 'suspended') {
    throw new InvalidOrgStatusTransitionError(
      `Cannot delete an org that is '${status}'; only 'active' or 'suspended' orgs can be.`,
    );
  }
}

export function assertCanCancelDeletion(status: OrgStatus): void {
  if (status !== 'pending_deletion') {
    throw new InvalidOrgStatusTransitionError(
      `There is no deletion to cancel for an org that is '${status}'.`,
    );
  }
}

/** When a deletion asked for at [requestedAt] goes ahead. */
export function deleteAfter(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000);
}

/** G-11 (4): a reseller is deleted only once it has no tenants left. */
export class OrgHasTenantsError extends Error {
  override readonly name = 'OrgHasTenantsError';
}
