import { describe, expect, it } from 'vitest';

import {
  allPermissions,
  CONFIG_READ_PERMISSIONS,
  dataClassOf,
  expandPermissions,
  grantingPermissions,
  holdsPermission,
  implies,
  isKnownPermission,
  PERMISSION_CATALOG,
  READ_TWINS,
  SELF_PERMISSIONS,
  UnknownPermissionError,
} from '../src/permissions.js';
import { isDataClass } from '../src/types.js';

describe('PERMISSION_CATALOG', () => {
  it('gives every permission a valid data class', () => {
    for (const [permission, dataClass] of Object.entries(PERMISSION_CATALOG)) {
      expect(isDataClass(dataClass), `${permission} → '${dataClass}'`).toBe(true);
    }
  });

  it('matches every permission named in 07 §3.3', () => {
    for (const permission of [
      'reseller.create',
      'reseller.manage',
      'tenant.create',
      'tenant.manage',
      'tenant.suspend',
      'brand.manage',
      'user.manage',
      'role.manage',
      'grant.manage',
      'extension.manage',
      'did.manage',
      'group.manage',
      'queue.manage',
      'schedule.manage',
      'media.manage',
      'trunk.manage',
      'callflow.edit',
      'callflow.publish',
      'secret.reveal',
      'recording.policy.manage',
      'recording.listen',
      'recording.download',
      'recording.delete',
      'cdr.read',
      'cdr.export',
      'voicemail.access',
      'monitor.presence',
      'monitor.listen',
      'monitor.whisper',
      'monitor.barge',
      'analytics.view',
      'audit.read',
      'apikey.manage',
    ]) {
      expect(isKnownPermission(permission), permission).toBe(true);
    }
  });

  it('assigns secret to exactly the credential-facing permissions', () => {
    expect(dataClassOf('secret.reveal')).toBe('secret');
    expect(dataClassOf('apikey.manage')).toBe('secret');
  });

  it('assigns private to the tenant-private surfaces', () => {
    for (const permission of [
      'cdr.read',
      'cdr.export',
      'recording.listen',
      'voicemail.access',
      'monitor.barge',
    ]) {
      expect(dataClassOf(permission)).toBe('private');
    }
  });

  it('includes domain.manage — S1-03, not in 07 §3.3, added for reseller base-domain routes', () => {
    expect(isKnownPermission('domain.manage')).toBe(true);
    expect(dataClassOf('domain.manage')).toBe('config');
  });

  it('includes parking_lot.manage — S2-14, not in 07 §3.3, added for parking-lot config routes', () => {
    expect(isKnownPermission('parking_lot.manage')).toBe(true);
    expect(dataClassOf('parking_lot.manage')).toBe('config');
  });

  it('includes conference_room.manage — S2-15, not in 07 §3.3, added for conference-room config routes', () => {
    expect(isKnownPermission('conference_room.manage')).toBe(true);
    expect(dataClassOf('conference_room.manage')).toBe('config');
  });

  it('includes billing.read — S2-18/C-1/D-013, a usage-class reseller billing view distinct from private-class cdr.read', () => {
    expect(isKnownPermission('billing.read')).toBe(true);
    expect(dataClassOf('billing.read')).toBe('usage');
  });

  it('includes monitor.calls — S5-08, not in 07 §3.3: watching live calls is private (H1), with no read twin', () => {
    expect(isKnownPermission('monitor.calls')).toBe(true);
    expect(dataClassOf('monitor.calls')).toBe('private');
    expect(Object.hasOwn(READ_TWINS, 'monitor.calls')).toBe(false);
    expect(Object.values(READ_TWINS)).not.toContain('monitor.calls');
  });

  it('includes the self-service permissions (parity 1e): voicemail and history are private, settings are config', () => {
    expect([...SELF_PERMISSIONS]).toEqual(['self.settings', 'self.voicemail', 'self.history']);
    for (const permission of SELF_PERMISSIONS) expect(isKnownPermission(permission)).toBe(true);
    expect(dataClassOf('self.settings')).toBe('config');
    expect(dataClassOf('self.voicemail')).toBe('private');
    expect(dataClassOf('self.history')).toBe('private');
  });
});

describe('dataClassOf', () => {
  it('throws a clear error for an unregistered permission', () => {
    expect(() => dataClassOf('made.up.permission')).toThrow(UnknownPermissionError);
    expect(() => dataClassOf('made.up.permission')).toThrow(/not in the permission catalog/);
  });
});

describe('allPermissions', () => {
  it('returns exactly the catalog keys, with no duplicates', () => {
    const all = allPermissions();
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(Object.keys(PERMISSION_CATALOG).sort());
  });
});

describe('read twins (G-10, S1-15)', () => {
  const TWINNED = [
    'reseller',
    'tenant',
    'domain',
    'brand',
    'user',
    'role',
    'grant',
    'extension',
    'did',
    'emergency_location',
    'emergency_route',
    'group',
    'queue',
    'parking_lot',
    'conference_room',
    'schedule',
    'media',
    'trunk',
    'recording.policy',
  ];

  it('gives every configuration .manage permission a .read twin of the same data class', () => {
    for (const resource of TWINNED) {
      const manage = `${resource}.manage`;
      const read = `${resource}.read`;
      expect(isKnownPermission(read), read).toBe(true);
      expect(READ_TWINS[manage], manage).toBe(read);
      expect(dataClassOf(read), read).toBe(dataClassOf(manage));
    }
  });

  it('twins every catalog .manage permission except the secret-class one', () => {
    for (const permission of allPermissions()) {
      if (!permission.endsWith('.manage')) continue;
      expect(Object.hasOwn(READ_TWINS, permission), permission).toBe(
        dataClassOf(permission) !== 'secret',
      );
    }
  });

  it('callflow.read is the twin of both callflow.edit and callflow.publish', () => {
    expect(dataClassOf('callflow.read')).toBe('config');
    expect(READ_TWINS['callflow.edit']).toBe('callflow.read');
    expect(READ_TWINS['callflow.publish']).toBe('callflow.read');
    expect([...grantingPermissions('callflow.read')].sort()).toEqual([
      'callflow.edit',
      'callflow.publish',
      'callflow.read',
    ]);
  });

  it('has no read twin for a secret-class permission', () => {
    expect(isKnownPermission('secret.read')).toBe(false);
    expect(isKnownPermission('apikey.read')).toBe(false);
  });

  it('CONFIG_READ_PERMISSIONS is exactly the set of twins, all config-class', () => {
    expect([...CONFIG_READ_PERMISSIONS].sort()).toEqual(
      [...new Set(Object.values(READ_TWINS))].sort(),
    );
    for (const permission of CONFIG_READ_PERMISSIONS) {
      expect(dataClassOf(permission)).toBe('config');
    }
  });

  it('implies: .manage gives .read, never the reverse, and nothing else', () => {
    expect(implies('extension.manage', 'extension.read')).toBe(true);
    expect(implies('extension.read', 'extension.read')).toBe(true);
    expect(implies('extension.read', 'extension.manage')).toBe(false);
    expect(implies('extension.manage', 'did.read')).toBe(false);
    expect(implies('tenant.create', 'tenant.read')).toBe(false);
    expect(implies('cdr.export', 'cdr.read')).toBe(false);
  });

  it('expandPermissions adds the implied reads and keeps everything held', () => {
    expect([...expandPermissions(['did.manage', 'cdr.read', 'callflow.publish'])].sort()).toEqual([
      'callflow.publish',
      'callflow.read',
      'cdr.read',
      'did.manage',
      'did.read',
    ]);
  });

  it('holdsPermission answers for a flat set, with the implication', () => {
    const held = new Set(['trunk.manage']);
    expect(holdsPermission(held, 'trunk.read')).toBe(true);
    expect(holdsPermission(held, 'trunk.manage')).toBe(true);
    expect(holdsPermission(held, 'extension.read')).toBe(false);
    expect(holdsPermission(new Set(['trunk.read']), 'trunk.manage')).toBe(false);
  });
});
