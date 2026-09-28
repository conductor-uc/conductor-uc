import { describe, expect, it } from 'vitest';

import {
  buildAffinityHairpinDocument,
  formatAffinityTarget,
  parseAffinityTarget,
  type AffinityTarget,
} from '../src/xml.js';

describe('the hairpin (S4-05)', () => {
  it('writes and reads back each target', () => {
    const targets: AffinityTarget[] = [
      { kind: 'queue', id: 'q-1' },
      { kind: 'queue', id: 'q-1', didId: 'd-1' },
      { kind: 'park', id: 'lot-1', slot: 705 },
      { kind: 'conf', id: 'room-1' },
    ];
    for (const target of targets) {
      expect(parseAffinityTarget(formatAffinityTarget(target))).toEqual(target);
    }
  });

  it('reads nothing from a malformed target', () => {
    for (const value of [
      '',
      'queue',
      'queue:',
      'queue:q-1:',
      'queue:q-1:d-1:x',
      'park:lot-1',
      'park:lot-1:seven',
      'conf:room-1:extra',
      'ring_group:rg-1',
    ]) {
      expect(parseAffinityTarget(value)).toBeUndefined();
    }
  });

  it('bridges back through OpenSIPs naming the owning node, the target and the tenant', () => {
    const document = buildAffinityHairpinDocument(
      'public',
      '+15551234567',
      'acme.example.test',
      'opensips:5060',
      'tenant-1',
      'sip:freeswitch-2:5060',
      { kind: 'queue', id: 'q-1', didId: 'd-1' },
    );
    expect(document).toContain(
      '<action application="bridge" data="{sip_route_uri=sip:opensips:5060,' +
        'sip_h_X-Affinity-Node=sip:freeswitch-2:5060,sip_h_X-Affinity-Target=queue:q-1:d-1,' +
        'sip_h_X-Affinity-Tenant=tenant-1}sofia/internal/+15551234567@acme.example.test"/>',
    );
    expect(document).toContain('cuc_tenant_id=tenant-1');
    expect(document).toContain('expression="^\\+15551234567$"');
  });
});
