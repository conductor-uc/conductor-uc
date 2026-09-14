import { describe, expect, it } from 'vitest';

import { allPermissions, isKnownPermission } from '../src/permissions.js';
import { BUILT_IN_ROLES, BUILT_IN_ROLE_IDS, isBuiltInRoleId, roleCatalog } from '../src/roles.js';
import type { Role } from '../src/types.js';

describe('BUILT_IN_ROLES', () => {
  it('defines exactly the roles named in 07 §3.3', () => {
    expect([...BUILT_IN_ROLES.keys()].sort()).toEqual([...BUILT_IN_ROLE_IDS].sort());
  });

  it('every permission every built-in role holds is in the catalog', () => {
    for (const [roleId, role] of BUILT_IN_ROLES) {
      for (const permission of role.permissions) {
        expect(isKnownPermission(permission), `${roleId} → ${permission}`).toBe(true);
      }
    }
  });

  it('master_admin holds every permission — "Master: Full" (SAD §3)', () => {
    const masterAdmin = BUILT_IN_ROLES.get('master_admin');
    expect(masterAdmin).toBeDefined();
    for (const permission of allPermissions()) {
      expect(masterAdmin?.permissions.has(permission), permission).toBe(true);
    }
  });

  it('reseller_admin never holds reseller.create or reseller.manage — H3 reserves those to master', () => {
    const resellerAdmin = BUILT_IN_ROLES.get('reseller_admin');
    expect(resellerAdmin?.permissions.has('reseller.create')).toBe(false);
    expect(resellerAdmin?.permissions.has('reseller.manage')).toBe(false);
  });

  it('reseller_admin holds tenant lifecycle management, per its documented default holder', () => {
    const resellerAdmin = BUILT_IN_ROLES.get('reseller_admin');
    for (const permission of ['tenant.create', 'tenant.manage', 'tenant.suspend']) {
      expect(resellerAdmin?.permissions.has(permission), permission).toBe(true);
    }
  });

  it('tenant_admin holds secret.reveal — audited, but a real tenant-admin capability', () => {
    expect(BUILT_IN_ROLES.get('tenant_admin')?.permissions.has('secret.reveal')).toBe(true);
  });

  it('monitor.listen/whisper/barge belong to tenant_supervisor, not tenant_admin', () => {
    const admin = BUILT_IN_ROLES.get('tenant_admin');
    const supervisor = BUILT_IN_ROLES.get('tenant_supervisor');
    for (const permission of ['monitor.listen', 'monitor.whisper', 'monitor.barge']) {
      expect(admin?.permissions.has(permission), `admin → ${permission}`).toBe(false);
      expect(supervisor?.permissions.has(permission), `supervisor → ${permission}`).toBe(true);
    }
  });

  it('tenant_user holds only the tenant-wide permission, not voicemail or recordings — those are per-scope grants', () => {
    const tenantUser = BUILT_IN_ROLES.get('tenant_user');
    expect(tenantUser?.permissions.has('monitor.presence')).toBe(true);
    expect(tenantUser?.permissions.has('voicemail.access')).toBe(false);
    expect(tenantUser?.permissions.has('recording.listen')).toBe(false);
  });
});

describe('isBuiltInRoleId', () => {
  it('recognizes every built-in id', () => {
    for (const id of BUILT_IN_ROLE_IDS) expect(isBuiltInRoleId(id)).toBe(true);
  });

  it('rejects a custom role id', () => {
    expect(isBuiltInRoleId('some-custom-role')).toBe(false);
  });
});

describe('roleCatalog', () => {
  it('returns the built-ins with no argument', () => {
    expect(roleCatalog().size).toBe(BUILT_IN_ROLE_IDS.length);
  });

  it('merges in custom roles', () => {
    const custom: Role = { id: 'custom-1', permissions: new Set(['cdr.read']) };
    const merged = roleCatalog([custom]);

    expect(merged.get('custom-1')).toEqual(custom);
    expect(merged.size).toBe(BUILT_IN_ROLE_IDS.length + 1);
  });

  it('lets an org override a built-in id, though nothing does this today', () => {
    const override: Role = { id: 'tenant_user', permissions: new Set(['cdr.read']) };
    const merged = roleCatalog([override]);

    expect(merged.get('tenant_user')).toEqual(override);
  });
});
