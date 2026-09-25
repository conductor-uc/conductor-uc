import { describe, expect, it } from 'vitest';

import {
  allPermissions,
  dataClassOf,
  isKnownPermission,
  PERMISSION_CATALOG,
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
