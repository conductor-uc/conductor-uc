import { describe, expect, it } from 'vitest';

import { allowed, grantMatches, roleHas } from '../src/evaluate.js';
import { roleCatalog } from '../src/roles.js';
import type { Actor, Grant, ResourceRef, Role } from '../src/types.js';

const catalog = roleCatalog();

const tenantAdmin: Actor = {
  id: 'u1',
  type: 'user',
  org: { id: 't1', type: 'tenant', resellerId: 'r1' },
  roleIds: ['tenant_admin'],
};
const tenantUser: Actor = {
  id: 'u2',
  type: 'user',
  org: { id: 't1', type: 'tenant', resellerId: 'r1' },
  roleIds: ['tenant_user'],
};
const own: ResourceRef = { org: tenantAdmin.org };

describe('roleHas', () => {
  it('is true when an assigned role bundles the permission', () => {
    expect(roleHas(tenantAdmin, 'extension.manage', catalog)).toBe(true);
  });

  it('is false when no assigned role bundles it', () => {
    expect(roleHas(tenantUser, 'extension.manage', catalog)).toBe(false);
  });

  it('checks every assigned role, not just the first', () => {
    const both: Actor = { ...tenantUser, roleIds: ['tenant_user', 'tenant_admin'] };
    expect(roleHas(both, 'extension.manage', catalog)).toBe(true);
  });

  it('ignores a role id the catalog does not have', () => {
    const unknown: Actor = { ...tenantUser, roleIds: ['not-a-real-role'] };
    expect(roleHas(unknown, 'extension.manage', catalog)).toBe(false);
  });

  it('finds a custom role merged into the catalog', () => {
    const custom: Role = { id: 'custom-1', permissions: new Set(['cdr.read']) };
    const merged = roleCatalog([custom]);
    const actor: Actor = { ...tenantUser, roleIds: ['custom-1'] };

    expect(roleHas(actor, 'cdr.read', merged)).toBe(true);
  });
});

describe('grantMatches', () => {
  it('matches a grant scoped to the actor’s own org for the resource’s org', () => {
    const grants: Grant[] = [
      {
        principalType: 'user',
        principalId: 'u2',
        permission: 'cdr.read',
        scope: { type: 'org', id: 't1' },
      },
    ];
    expect(grantMatches(tenantUser, 'cdr.read', own, grants)).toBe(true);
  });

  it('matches a grant scoped to the exact resource scope', () => {
    const resource: ResourceRef = { org: tenantUser.org, scope: { type: 'mailbox', id: 'mb-1' } };
    const grants: Grant[] = [
      {
        principalType: 'user',
        principalId: 'u2',
        permission: 'voicemail.access',
        scope: { type: 'mailbox', id: 'mb-1' },
      },
    ];
    expect(grantMatches(tenantUser, 'voicemail.access', resource, grants)).toBe(true);
  });

  it('does not match a grant scoped to a different mailbox', () => {
    const resource: ResourceRef = { org: tenantUser.org, scope: { type: 'mailbox', id: 'mb-2' } };
    const grants: Grant[] = [
      {
        principalType: 'user',
        principalId: 'u2',
        permission: 'voicemail.access',
        scope: { type: 'mailbox', id: 'mb-1' },
      },
    ];
    expect(grantMatches(tenantUser, 'voicemail.access', resource, grants)).toBe(false);
  });

  it('does not match a grant for a different permission', () => {
    const grants: Grant[] = [
      {
        principalType: 'user',
        principalId: 'u2',
        permission: 'cdr.export',
        scope: { type: 'org', id: 't1' },
      },
    ];
    expect(grantMatches(tenantUser, 'cdr.read', own, grants)).toBe(false);
  });

  it('does not match a grant for a different user', () => {
    const grants: Grant[] = [
      {
        principalType: 'user',
        principalId: 'someone-else',
        permission: 'cdr.read',
        scope: { type: 'org', id: 't1' },
      },
    ];
    expect(grantMatches(tenantUser, 'cdr.read', own, grants)).toBe(false);
  });

  it('matches a grant made to a role the actor holds', () => {
    const grants: Grant[] = [
      {
        principalType: 'role',
        principalId: 'tenant_user',
        permission: 'cdr.read',
        scope: { type: 'org', id: 't1' },
      },
    ];
    expect(grantMatches(tenantUser, 'cdr.read', own, grants)).toBe(true);
  });

  it('an org-scoped grant covers a finer-scoped resource in the same org', () => {
    const resource: ResourceRef = { org: tenantUser.org, scope: { type: 'mailbox', id: 'mb-1' } };
    const grants: Grant[] = [
      {
        principalType: 'user',
        principalId: 'u2',
        permission: 'voicemail.access',
        scope: { type: 'org', id: 't1' },
      },
    ];
    expect(grantMatches(tenantUser, 'voicemail.access', resource, grants)).toBe(true);
  });
});

describe('allowed', () => {
  it('allows a tenant admin to manage extensions in their own org', () => {
    expect(allowed({ actor: tenantAdmin, permission: 'extension.manage', resource: own })).toBe(
      true,
    );
  });

  it('denies without a role or a matching grant', () => {
    expect(allowed({ actor: tenantUser, permission: 'extension.manage', resource: own })).toBe(
      false,
    );
  });

  it('a grant alone is enough — tenant_user holds no cdr.read permission via its role', () => {
    expect(roleHas(tenantUser, 'cdr.read', roleCatalog())).toBe(false);

    const grants: Grant[] = [
      {
        principalType: 'user',
        principalId: 'u2',
        permission: 'cdr.read',
        scope: { type: 'org', id: 't1' },
      },
    ];
    expect(allowed({ actor: tenantUser, permission: 'cdr.read', resource: own, grants })).toBe(
      true,
    );
    expect(allowed({ actor: tenantUser, permission: 'cdr.read', resource: own })).toBe(false);
  });

  it('a hard rule denies even with a role that bundles the permission', () => {
    const resellerAdmin: Actor = {
      id: 'u4',
      type: 'user',
      org: { id: 'r1', type: 'reseller', resellerId: null },
      roleIds: ['reseller_admin'],
    };
    // reseller_admin does not even hold cdr.read, but the point is H1 denies
    // it outright regardless — assign it a custom role that does, and it is
    // still denied.
    const custom: Role = { id: 'custom-cdr', permissions: new Set(['cdr.read']) };
    const roles = roleCatalog([custom]);
    const actor: Actor = { ...resellerAdmin, roleIds: ['custom-cdr'] };

    expect(allowed({ actor, permission: 'cdr.read', resource: own, roles })).toBe(false);
  });

  it('denies across org ancestry even with the right role', () => {
    const otherTenantResource: ResourceRef = {
      org: { id: 't2', type: 'tenant', resellerId: 'r2' },
    };
    expect(
      allowed({
        actor: tenantAdmin,
        permission: 'extension.manage',
        resource: otherTenantResource,
      }),
    ).toBe(false);
  });
});

describe('self-service permissions (parity 1e)', () => {
  const reseller: Actor = {
    id: 'u9',
    type: 'user',
    org: { id: 'r1', type: 'reseller', resellerId: null },
    roleIds: ['tenant_user'],
  };
  const otherTenantUser: Actor = {
    id: 'u3',
    type: 'user',
    org: { id: 't2', type: 'tenant', resellerId: 'r1' },
    roleIds: ['tenant_user'],
  };

  it('a tenant_user holds all three in its own tenant', () => {
    for (const permission of ['self.settings', 'self.voicemail', 'self.history']) {
      expect(allowed({ actor: tenantUser, permission, resource: own }), permission).toBe(true);
    }
  });

  it('a tenant_user holds none of the org-wide equivalents', () => {
    for (const permission of ['extension.manage', 'voicemail.access', 'cdr.read']) {
      expect(allowed({ actor: tenantUser, permission, resource: own }), permission).toBe(false);
    }
  });

  it('a tenant_user of another tenant is denied all three here (H2)', () => {
    for (const permission of ['self.settings', 'self.voicemail', 'self.history']) {
      expect(allowed({ actor: otherTenantUser, permission, resource: own }), permission).toBe(
        false,
      );
    }
  });

  it('a reseller is denied the private ones even if it somehow held the role (H1), and settings by ancestry only when it holds them', () => {
    expect(allowed({ actor: reseller, permission: 'self.voicemail', resource: own })).toBe(false);
    expect(allowed({ actor: reseller, permission: 'self.history', resource: own })).toBe(false);
  });
});
