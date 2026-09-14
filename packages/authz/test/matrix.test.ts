import { describe, expect, it } from 'vitest';

import { allowed } from '../src/evaluate.js';
import { allPermissions, dataClassOf } from '../src/permissions.js';
import type { Actor, OrgRef, Permission, ResourceRef, Role, RoleCatalog } from '../src/types.js';

/**
 * Every actor in this matrix holds a synthetic role bundling *every*
 * permission in the catalog — not one of the real built-in `*_admin` roles.
 * That is deliberate: this matrix tests what ancestry and the hard rules
 * permit in principle, for each org tier, decoupled from which specific
 * built-in role happens to bundle which permission (`tenant_admin` does not
 * hold `monitor.barge` — `tenant_supervisor` does — and that split is its own
 * correct, separately-tested design choice, not something this matrix should
 * be sensitive to).
 */
const HOLDS_EVERYTHING_ROLE_ID = 'holds-everything';
function allPermissionsRoleCatalog(): RoleCatalog {
  const role: Role = { id: HOLDS_EVERYTHING_ROLE_ID, permissions: new Set(allPermissions()) };
  return new Map([[HOLDS_EVERYTHING_ROLE_ID, role]]);
}
const roles = allPermissionsRoleCatalog();

/**
 * The acceptance criterion for S1-06: a generated matrix test covering every
 * (org type × permission × data class) combination, matching the table in
 * SAD §3:
 *
 * | Role     | Own config/admin data   | Other resellers' data | Tenant private data     |
 * |----------|-------------------------|------------------------|--------------------------|
 * | Master   | Full                    | Full                   | Full                    |
 * | Reseller | Full, for own tenants   | None                   | No access               |
 * | Tenant   | Full, for own org       | N/A                    | Full, for own org       |
 *
 * "Own config/admin data" and "tenant private data" are read directly off
 * the permission catalog's data class, not hand-picked — every permission in
 * {@link allPermissions} is exercised. Each actor is assigned the built-in
 * *_admin role for its tier, which the roles test file already establishes
 * holds the permission in the ordinary case; what this test is actually
 * checking is that ancestry and the hard rules produce the right allow/deny
 * *regardless* of what the role bundles, for a resource in each of three
 * relationships to the actor's org.
 */

const master: OrgRef = { id: 'master-1', type: 'master', resellerId: null };
const ownReseller: OrgRef = { id: 'reseller-1', type: 'reseller', resellerId: null };
const otherReseller: OrgRef = { id: 'reseller-2', type: 'reseller', resellerId: null };
const ownTenant: OrgRef = { id: 'tenant-1', type: 'tenant', resellerId: ownReseller.id };
const otherTenantSameReseller: OrgRef = {
  id: 'tenant-2',
  type: 'tenant',
  resellerId: ownReseller.id,
};
const otherTenantOtherReseller: OrgRef = {
  id: 'tenant-3',
  type: 'tenant',
  resellerId: otherReseller.id,
};

const masterActor: Actor = {
  id: 'master-admin',
  type: 'user',
  org: master,
  roleIds: [HOLDS_EVERYTHING_ROLE_ID],
};
const resellerActor: Actor = {
  id: 'reseller-admin',
  type: 'user',
  org: ownReseller,
  roleIds: [HOLDS_EVERYTHING_ROLE_ID],
};
const tenantActor: Actor = {
  id: 'tenant-admin',
  type: 'user',
  org: ownTenant,
  roleIds: [HOLDS_EVERYTHING_ROLE_ID],
};

type OrgTypeUnderTest = 'master' | 'reseller' | 'tenant';

interface Scenario {
  readonly actor: Actor;
  readonly resource: ResourceRef;
  /** What SAD §3's table calls this resource, for a readable failure message. */
  readonly relationship: string;
}

/** Every (actor org type × resource relationship) scenario the SAD §3 table describes. */
function scenariosFor(actorType: OrgTypeUnderTest): readonly Scenario[] {
  switch (actorType) {
    case 'master':
      return [
        { actor: masterActor, resource: { org: master }, relationship: 'own org' },
        {
          actor: masterActor,
          resource: { org: ownReseller },
          relationship: "a reseller's own data",
        },
        { actor: masterActor, resource: { org: ownTenant }, relationship: "a tenant's data" },
      ];
    case 'reseller':
      return [
        { actor: resellerActor, resource: { org: ownReseller }, relationship: 'own org' },
        { actor: resellerActor, resource: { org: ownTenant }, relationship: 'own tenant' },
        {
          actor: resellerActor,
          resource: { org: otherReseller },
          relationship: "another reseller's own data",
        },
        {
          actor: resellerActor,
          resource: { org: otherTenantOtherReseller },
          relationship: "another reseller's tenant",
        },
      ];
    case 'tenant':
      return [
        { actor: tenantActor, resource: { org: ownTenant }, relationship: 'own org' },
        {
          actor: tenantActor,
          resource: { org: otherTenantSameReseller },
          relationship: 'a sibling tenant',
        },
        {
          actor: tenantActor,
          resource: { org: otherTenantOtherReseller },
          relationship: 'an unrelated tenant',
        },
      ];
  }
}

/**
 * The expected result, derived from the SAD §3 table rather than from
 * `allowed()` itself — this is the independent check the acceptance
 * criterion asks for.
 */
function expectedResult(
  actorType: OrgTypeUnderTest,
  permission: Permission,
  relationship: string,
): boolean {
  const dataClass = dataClassOf(permission);

  // H3 is unconditional: nobody but master may create or manage a reseller,
  // whatever the resource relationship. Checked first, matching how
  // hardRulesPass itself checks every hard rule before anything else.
  if (
    (permission === 'reseller.create' || permission === 'reseller.manage') &&
    actorType !== 'master'
  ) {
    return false;
  }

  if (actorType === 'master') {
    // "Master: Full" on everything, own data, other resellers' data, and
    // tenant private data alike — the one exception is H3, which is not a
    // data-class question at all: nobody but master may hold it, so it
    // cannot appear as a false negative here.
    return true;
  }

  if (actorType === 'reseller') {
    if (relationship === 'own org') {
      // H1 is specifically "on a tenant resource" — the reseller's own org
      // row is not one, so H1 does not fire here at all, private-class
      // permission or not. H3 was already ruled out above.
      return true;
    }
    if (relationship === 'own tenant') {
      // "Full, for own tenants" — except H1's private-data wall, which is not
      // lifted just because the tenant is the reseller's own.
      return dataClass !== 'private';
    }
    // "None" for another reseller's own data or its tenants: ancestry alone
    // already denies both, whatever the permission or data class.
    return false;
  }

  // Tenant: "Full, for own org" including its own private data (H1 only
  // restricts resellers); "N/A" for anything outside itself, which ancestry
  // realizes as a plain denial. H3 was already ruled out above.
  if (relationship === 'own org') return true;
  return false;
}

describe('matrix: (org type × permission × relationship) vs SAD §3', () => {
  const orgTypes: readonly OrgTypeUnderTest[] = ['master', 'reseller', 'tenant'];

  for (const actorType of orgTypes) {
    describe(actorType, () => {
      for (const scenario of scenariosFor(actorType)) {
        describe(scenario.relationship, () => {
          for (const permission of allPermissions()) {
            const expected = expectedResult(actorType, permission, scenario.relationship);

            it(`${permission} (${dataClassOf(permission)}) → ${expected ? 'allow' : 'deny'}`, () => {
              expect(
                allowed({ actor: scenario.actor, permission, resource: scenario.resource, roles }),
              ).toBe(expected);
            });
          }
        });
      }
    });
  }
});

describe('H1 cannot be overridden by any grant — the other half of the acceptance criterion', () => {
  it('denies a reseller a private permission on its own tenant even with an explicit org-scoped grant', () => {
    const grants = [
      {
        principalType: 'user' as const,
        principalId: resellerActor.id,
        permission: 'cdr.read',
        scope: { type: 'org' as const, id: ownTenant.id },
      },
    ];

    expect(
      allowed({
        actor: resellerActor,
        permission: 'cdr.read',
        resource: { org: ownTenant },
        grants,
      }),
    ).toBe(false);
  });

  it('denies it even with a custom role that bundles every private permission', () => {
    const everyPrivatePermission = allPermissions().filter((p) => dataClassOf(p) === 'private');
    const roles = new Map([
      [
        'reseller-superuser',
        { id: 'reseller-superuser', permissions: new Set(everyPrivatePermission) },
      ],
    ]);
    const actor: Actor = { ...resellerActor, roleIds: ['reseller-superuser'] };

    for (const permission of everyPrivatePermission) {
      expect(allowed({ actor, permission, resource: { org: ownTenant }, roles })).toBe(false);
    }
  });

  it('still allows the master the same permissions on the same tenant', () => {
    const everyPrivatePermission = allPermissions().filter((p) => dataClassOf(p) === 'private');

    for (const permission of everyPrivatePermission) {
      expect(allowed({ actor: masterActor, permission, resource: { org: ownTenant }, roles })).toBe(
        true,
      );
    }
  });
});
