import { describe, expect, it } from 'vitest';

import {
  h1PrivateDataWall,
  h2TenantBoundary,
  h3ResellerLifecycle,
  h4ApiKeyRestriction,
  hardRulesPass,
} from '../src/hard-rules.js';
import type { Actor, ResourceRef } from '../src/types.js';

const resellerActor: Actor = {
  id: 'u1',
  type: 'user',
  org: { id: 'r1', type: 'reseller', resellerId: null },
  roleIds: ['reseller_admin'],
};
const masterActor: Actor = {
  id: 'u2',
  type: 'user',
  org: { id: 'm1', type: 'master', resellerId: null },
  roleIds: ['master_admin'],
};
const tenantActor: Actor = {
  id: 'u3',
  type: 'user',
  org: { id: 't1', type: 'tenant', resellerId: 'r1' },
  roleIds: ['tenant_admin'],
};
const tenantResource: ResourceRef = { org: { id: 't1', type: 'tenant', resellerId: 'r1' } };
const otherTenantResource: ResourceRef = { org: { id: 't2', type: 'tenant', resellerId: 'r1' } };

describe('h1PrivateDataWall', () => {
  it('denies a reseller on a private permission against a tenant, even its own', () => {
    expect(h1PrivateDataWall(resellerActor, 'cdr.read', tenantResource)).toBe(false);
  });

  it('allows a reseller on a config permission against its own tenant', () => {
    expect(h1PrivateDataWall(resellerActor, 'extension.manage', tenantResource)).toBe(true);
  });

  it('allows a master on a private permission — masters are only audited, not denied', () => {
    expect(h1PrivateDataWall(masterActor, 'cdr.read', tenantResource)).toBe(true);
  });

  it('allows a tenant on its own private data', () => {
    expect(h1PrivateDataWall(tenantActor, 'cdr.read', tenantResource)).toBe(true);
  });

  it('cannot be bypassed by which permission is asked for — it checks the data class, not the name', () => {
    // Every private permission triggers it, not a hardcoded list of names.
    for (const permission of [
      'recording.listen',
      'voicemail.access',
      'monitor.barge',
      'analytics.view',
    ]) {
      expect(h1PrivateDataWall(resellerActor, permission, tenantResource)).toBe(false);
    }
  });
});

describe('h2TenantBoundary', () => {
  it('denies a tenant actor acting on a different tenant', () => {
    expect(h2TenantBoundary(tenantActor, otherTenantResource)).toBe(false);
  });

  it('allows a tenant actor acting on its own org', () => {
    expect(h2TenantBoundary(tenantActor, tenantResource)).toBe(true);
  });

  it('does not restrict a reseller or master actor', () => {
    expect(h2TenantBoundary(resellerActor, otherTenantResource)).toBe(true);
    expect(h2TenantBoundary(masterActor, otherTenantResource)).toBe(true);
  });
});

describe('h3ResellerLifecycle', () => {
  it('denies a reseller creating or managing a reseller', () => {
    expect(h3ResellerLifecycle(resellerActor, 'reseller.create')).toBe(false);
    expect(h3ResellerLifecycle(resellerActor, 'reseller.manage')).toBe(false);
  });

  it('denies a tenant the same way', () => {
    expect(h3ResellerLifecycle(tenantActor, 'reseller.create')).toBe(false);
  });

  it('allows a master to create or manage a reseller', () => {
    expect(h3ResellerLifecycle(masterActor, 'reseller.create')).toBe(true);
    expect(h3ResellerLifecycle(masterActor, 'reseller.manage')).toBe(true);
  });

  it('does not restrict an unrelated permission', () => {
    expect(h3ResellerLifecycle(resellerActor, 'tenant.create')).toBe(true);
  });
});

describe('h4ApiKeyRestriction', () => {
  const apiKeyActor: Actor = { ...tenantActor, type: 'apikey' };

  it('denies an API key managing users, roles, grants, or API keys', () => {
    for (const permission of ['user.manage', 'role.manage', 'grant.manage', 'apikey.manage']) {
      expect(h4ApiKeyRestriction(apiKeyActor, permission)).toBe(false);
    }
  });

  it('allows a user actor to hold the same permissions', () => {
    expect(h4ApiKeyRestriction(tenantActor, 'user.manage')).toBe(true);
  });

  it('does not restrict an API key from an unrelated permission', () => {
    expect(h4ApiKeyRestriction(apiKeyActor, 'extension.manage')).toBe(true);
  });
});

describe('hardRulesPass', () => {
  it('fails when any single rule fails', () => {
    expect(hardRulesPass(resellerActor, 'cdr.read', tenantResource)).toBe(false);
  });

  it('passes when every rule passes', () => {
    expect(hardRulesPass(tenantActor, 'extension.manage', tenantResource)).toBe(true);
  });
});
