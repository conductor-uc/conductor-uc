import { describe, expect, it } from 'vitest';

import {
  allPermissions,
  CONFIG_READ_PERMISSIONS,
  dataClassOf,
  isKnownPermission,
  READ_TWINS,
  SELF_PERMISSIONS,
} from '../src/permissions.js';
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

  it('reseller_admin never holds reseller.create, reseller.manage or reseller.read — H3 reserves those to master', () => {
    const resellerAdmin = BUILT_IN_ROLES.get('reseller_admin');
    expect(resellerAdmin?.permissions.has('reseller.create')).toBe(false);
    expect(resellerAdmin?.permissions.has('reseller.manage')).toBe(false);
    expect(resellerAdmin?.permissions.has('reseller.read')).toBe(false);
  });

  it('reseller_admin holds tenant lifecycle management, per its documented default holder', () => {
    const resellerAdmin = BUILT_IN_ROLES.get('reseller_admin');
    for (const permission of ['tenant.create', 'tenant.manage', 'tenant.suspend']) {
      expect(resellerAdmin?.permissions.has(permission), permission).toBe(true);
    }
  });

  it('reseller_admin holds domain.manage — registers and verifies its own base domains', () => {
    expect(BUILT_IN_ROLES.get('reseller_admin')?.permissions.has('domain.manage')).toBe(true);
  });

  it('tenant_admin does not hold domain.manage — a tenant domain is assigned, not self-managed', () => {
    expect(BUILT_IN_ROLES.get('tenant_admin')?.permissions.has('domain.manage')).toBe(false);
  });

  it('reseller_admin and tenant_admin both hold parking_lot.manage — same tier as queue.manage', () => {
    expect(BUILT_IN_ROLES.get('reseller_admin')?.permissions.has('parking_lot.manage')).toBe(true);
    expect(BUILT_IN_ROLES.get('tenant_admin')?.permissions.has('parking_lot.manage')).toBe(true);
  });

  it('reseller_admin and tenant_admin both hold conference_room.manage — same tier as queue.manage', () => {
    expect(BUILT_IN_ROLES.get('reseller_admin')?.permissions.has('conference_room.manage')).toBe(
      true,
    );
    expect(BUILT_IN_ROLES.get('tenant_admin')?.permissions.has('conference_room.manage')).toBe(
      true,
    );
  });

  it('reseller_admin holds billing.read but tenant_admin does not — C-1/D-013: the usage-class billing view is reseller-facing, a tenant already gets the full private-class CDR via cdr.read', () => {
    expect(BUILT_IN_ROLES.get('reseller_admin')?.permissions.has('billing.read')).toBe(true);
    expect(BUILT_IN_ROLES.get('tenant_admin')?.permissions.has('billing.read')).toBe(false);
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

  it('monitor.calls (S5-08) belongs to tenant_admin, tenant_supervisor and master_support, and to no reseller or plain user', () => {
    for (const roleId of ['master_admin', 'master_support', 'tenant_admin', 'tenant_supervisor']) {
      expect(BUILT_IN_ROLES.get(roleId as never)?.permissions.has('monitor.calls'), roleId).toBe(
        true,
      );
    }
    for (const roleId of ['reseller_admin', 'reseller_support', 'tenant_user']) {
      expect(BUILT_IN_ROLES.get(roleId as never)?.permissions.has('monitor.calls'), roleId).toBe(
        false,
      );
    }
  });

  it('recording.control (S5-15) belongs to tenant_admin and tenant_supervisor (and master_admin, which holds all), never to support, a reseller or a plain user', () => {
    for (const roleId of ['master_admin', 'tenant_admin', 'tenant_supervisor']) {
      expect(
        BUILT_IN_ROLES.get(roleId as never)?.permissions.has('recording.control'),
        roleId,
      ).toBe(true);
    }
    for (const roleId of ['master_support', 'reseller_admin', 'reseller_support', 'tenant_user']) {
      expect(
        BUILT_IN_ROLES.get(roleId as never)?.permissions.has('recording.control'),
        roleId,
      ).toBe(false);
    }
  });

  it('tenant_user holds only the self-service permissions plus the two every signed-in person needs', () => {
    const tenantUser = BUILT_IN_ROLES.get('tenant_user');
    expect([...(tenantUser?.permissions ?? [])].sort()).toEqual(
      ['monitor.presence', 'org.view', ...SELF_PERMISSIONS].sort(),
    );
  });

  it('tenant_user holds no org-wide voicemail, recording, CDR or management permission', () => {
    const tenantUser = BUILT_IN_ROLES.get('tenant_user');
    for (const permission of tenantUser?.permissions ?? []) {
      if (permission.startsWith('self.')) continue;
      expect(['org.view', 'monitor.presence'], permission).toContain(permission);
    }
    for (const permission of [
      'voicemail.access',
      'recording.listen',
      'cdr.read',
      'extension.manage',
      'user.manage',
      'role.manage',
      'grant.manage',
    ]) {
      expect(tenantUser?.permissions.has(permission), permission).toBe(false);
    }
  });

  it('every tenant-tier role holds the self-service permissions, so a linked admin has a My phone too', () => {
    for (const roleId of ['tenant_admin', 'tenant_supervisor', 'tenant_user']) {
      for (const permission of SELF_PERMISSIONS) {
        expect(BUILT_IN_ROLES.get(roleId as never)?.permissions.has(permission), roleId).toBe(true);
      }
    }
  });

  it('no reseller or master-support role holds a self-service permission — there is nothing of their own to see, and voicemail and history are private (H1)', () => {
    for (const roleId of ['reseller_admin', 'reseller_support', 'master_support']) {
      for (const permission of SELF_PERMISSIONS) {
        expect(BUILT_IN_ROLES.get(roleId as never)?.permissions.has(permission), roleId).toBe(
          false,
        );
      }
    }
  });
});

describe('support roles read configuration (G-10, S1-15)', () => {
  const writes = (roleId: string) =>
    [...(BUILT_IN_ROLES.get(roleId as never)?.permissions ?? [])].filter(
      (p) => Object.hasOwn(READ_TWINS, p) || p.endsWith('.create') || p.endsWith('.suspend'),
    );

  it('master_support holds every configuration read', () => {
    const role = BUILT_IN_ROLES.get('master_support');
    for (const permission of CONFIG_READ_PERMISSIONS) {
      expect(role?.permissions.has(permission), permission).toBe(true);
    }
  });

  it('master_support keeps its read-shaped and private reads, and adds billing.read', () => {
    const role = BUILT_IN_ROLES.get('master_support');
    for (const permission of [
      'org.view',
      'cdr.read',
      'analytics.view',
      'audit.read',
      'monitor.presence',
      'monitor.calls',
      'billing.read',
    ]) {
      expect(role?.permissions.has(permission), permission).toBe(true);
    }
  });

  it('master_support holds no write, secret or active-monitoring permission', () => {
    const role = BUILT_IN_ROLES.get('master_support');
    expect(writes('master_support')).toEqual([]);
    for (const permission of role?.permissions ?? []) {
      expect(dataClassOf(permission), permission).not.toBe('secret');
    }
    for (const permission of [
      'secret.reveal',
      'cdr.export',
      'recording.delete',
      'monitor.barge',
      'voicemail.access',
    ]) {
      expect(role?.permissions.has(permission), permission).toBe(false);
    }
  });

  it('reseller_support reads exactly what reseller_admin manages, plus org.view and audit.read', () => {
    const admin = BUILT_IN_ROLES.get('reseller_admin');
    const expected = [
      'org.view',
      'audit.read',
      ...[...(admin?.permissions ?? [])].flatMap((p) =>
        Object.hasOwn(READ_TWINS, p) ? [READ_TWINS[p] as string] : [],
      ),
    ];
    const support = BUILT_IN_ROLES.get('reseller_support');
    expect([...(support?.permissions ?? [])].sort()).toEqual([...new Set(expected)].sort());
    for (const permission of ['extension.read', 'tenant.read', 'trunk.read', 'brand.read']) {
      expect(support?.permissions.has(permission), permission).toBe(true);
    }
  });

  it('reseller_support holds no write, no private permission, and not reseller.read (H3)', () => {
    const role = BUILT_IN_ROLES.get('reseller_support');
    expect(writes('reseller_support')).toEqual([]);
    for (const permission of role?.permissions ?? []) {
      // audit.read is config/private: the audit query keeps private entries from a reseller (G-13).
      if (permission === 'audit.read') continue;
      expect(dataClassOf(permission), permission).toBe('config');
    }
    expect(role?.permissions.has('reseller.read')).toBe(false);
  });

  it('tenant_supervisor reads queues and extensions but manages neither', () => {
    const role = BUILT_IN_ROLES.get('tenant_supervisor');
    expect(role?.permissions.has('queue.read')).toBe(true);
    expect(role?.permissions.has('extension.read')).toBe(true);
    expect(writes('tenant_supervisor')).toEqual([]);
  });

  it('the admin roles list .manage only; the reads come from the implication', () => {
    for (const roleId of ['reseller_admin', 'tenant_admin']) {
      for (const permission of CONFIG_READ_PERMISSIONS) {
        expect(BUILT_IN_ROLES.get(roleId as never)?.permissions.has(permission), roleId).toBe(
          false,
        );
      }
    }
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
