import type { OrgType } from '../schema.js';

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
