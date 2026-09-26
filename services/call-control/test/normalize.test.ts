import { describe, expect, it } from 'vitest';

import { normalizeEslEvent } from '../src/normalize.js';

describe('normalizeEslEvent', () => {
  it('maps CHANNEL_CREATE to a created action with tenant derived from the X-Tenant-Id header variable', () => {
    const action = normalizeEslEvent('fs-1', {
      'Event-Name': 'CHANNEL_CREATE',
      'Unique-ID': 'abc',
      'Call-Direction': 'outbound',
      'Caller-Caller-ID-Number': '1001',
      'Caller-Destination-Number': '+15551234567',
      'variable_sip_h_X-Tenant-Id': 'tenant-1',
      'Event-Date-Timestamp': '1700000000000000',
    });

    expect(action).toEqual({
      kind: 'created',
      call: {
        callUuid: 'abc',
        nodeId: 'fs-1',
        tenantId: 'tenant-1',
        direction: 'outbound',
        state: 'ringing',
        startedAt: '1700000000000',
        from: '1001',
        to: '+15551234567',
        // An outbound leg is the number it rang; that is not an extension number here.
        extension: null,
        controls: 'none',
      },
    });
  });

  describe('the extension a leg belongs to (S5-15)', () => {
    const created = (raw: Record<string, string>) => {
      const action = normalizeEslEvent('fs-1', {
        'Event-Name': 'CHANNEL_CREATE',
        'Unique-ID': 'abc',
        ...raw,
      });
      if (action.kind !== 'created') throw new Error(action.kind);
      return action.call;
    };

    it('a phone calling in (OpenSIPs vouched with X-Tenant-Id) is its SIP From user', () => {
      expect(
        created({
          'Call-Direction': 'inbound',
          'Caller-Caller-ID-Number': '402',
          'Caller-Destination-Number': '401',
          'variable_sip_h_X-Tenant-Id': 'tenant-1',
          variable_sip_from_user: '402',
        }).extension,
      ).toBe('402');
    });

    it('a trunk caller is never an extension, whatever its caller ID looks like', () => {
      expect(
        created({
          'Call-Direction': 'inbound',
          'Caller-Caller-ID-Number': '401',
          variable_sip_from_user: '401',
          variable_cuc_tenant_id: 'tenant-1',
        }).extension,
      ).toBeNull();
    });

    it('a leg the node placed is the extension it rang, when it is an extension number', () => {
      expect(
        created({ 'Call-Direction': 'outbound', 'Caller-Destination-Number': '401' }).extension,
      ).toBe('401');
      expect(
        created({ 'Call-Direction': 'outbound', 'Caller-Destination-Number': '+15551234567' })
          .extension,
      ).toBeNull();
    });

    it('reads cuc_rec_controls when the leg already carries it (an exported variable)', () => {
      expect(created({ variable_cuc_rec_controls: 'pause' }).controls).toBe('pause');
      expect(created({ variable_cuc_rec_controls: 'bogus' }).controls).toBe('none');
    });
  });

  it('S5-15: answer and bridge carry cuc_rec_controls when the channel has it, and only then', () => {
    expect(
      normalizeEslEvent('fs-1', {
        'Event-Name': 'CHANNEL_ANSWER',
        'Unique-ID': 'abc',
        'Event-Date-Timestamp': '1700000000000000',
        variable_cuc_rec_controls: 'on_demand',
      }),
    ).toMatchObject({ kind: 'answered', controls: 'on_demand' });
    expect(
      normalizeEslEvent('fs-1', {
        'Event-Name': 'CHANNEL_BRIDGE',
        'Unique-ID': 'abc',
        'Other-Leg-Unique-ID': 'def',
        variable_cuc_rec_controls: 'pause',
      }),
    ).toMatchObject({ kind: 'bridged', controls: 'pause' });
  });

  it('S5-15: CUSTOM cuc::recording is a pause or a resume of the owner channel', () => {
    const custom = (headers: Record<string, string>) =>
      normalizeEslEvent('fs-1', {
        'Event-Name': 'CUSTOM',
        'Event-Subclass': 'cuc::recording',
        ...headers,
      });
    expect(custom({ 'Recording-Call-UUID': 'own', 'Recording-Action': 'paused' })).toEqual({
      kind: 'recordingPaused',
      callUuid: 'own',
      nodeId: 'fs-1',
      tenantId: null,
    });
    expect(custom({ 'Recording-Call-UUID': 'own', 'Recording-Action': 'resumed' })).toMatchObject({
      kind: 'recordingResumed',
    });
    expect(custom({ 'Recording-Call-UUID': 'own', 'Recording-Action': 'started' })).toEqual({
      kind: 'ignored',
    });
    expect(custom({ 'Recording-Action': 'paused' })).toEqual({ kind: 'ignored' });
  });

  it('defaults direction to inbound and tenantId to null when absent', () => {
    const action = normalizeEslEvent('fs-1', {
      'Event-Name': 'CHANNEL_CREATE',
      'Unique-ID': 'abc',
    });
    expect(action.kind).toBe('created');
    if (action.kind === 'created') {
      expect(action.call.direction).toBe('inbound');
      expect(action.call.tenantId).toBeNull();
    }
  });

  it('maps CHANNEL_ANSWER to an answered action', () => {
    const action = normalizeEslEvent('fs-1', {
      'Event-Name': 'CHANNEL_ANSWER',
      'Unique-ID': 'abc',
      'Event-Date-Timestamp': '1700000000000000',
    });
    expect(action).toEqual({
      kind: 'answered',
      callUuid: 'abc',
      nodeId: 'fs-1',
      tenantId: null,
      answeredAt: '1700000000000',
    });
  });

  it('maps CHANNEL_BRIDGE to a bridged action with the other leg id', () => {
    expect(
      normalizeEslEvent('fs-1', {
        'Event-Name': 'CHANNEL_BRIDGE',
        'Unique-ID': 'abc',
        'Other-Leg-Unique-ID': 'def',
      }),
    ).toEqual({
      kind: 'bridged',
      callUuid: 'abc',
      nodeId: 'fs-1',
      tenantId: null,
      bridgedTo: 'def',
    });
  });

  it('ignores CHANNEL_BRIDGE with no other-leg id', () => {
    expect(
      normalizeEslEvent('fs-1', { 'Event-Name': 'CHANNEL_BRIDGE', 'Unique-ID': 'abc' }),
    ).toEqual({
      kind: 'ignored',
    });
  });

  it('maps CHANNEL_HOLD to a held action', () => {
    expect(normalizeEslEvent('fs-1', { 'Event-Name': 'CHANNEL_HOLD', 'Unique-ID': 'abc' })).toEqual(
      {
        kind: 'held',
        callUuid: 'abc',
        nodeId: 'fs-1',
        tenantId: null,
      },
    );
  });

  it('maps CHANNEL_UNHOLD, RECORD_START and RECORD_STOP (S5-08)', () => {
    for (const [eventName, kind] of [
      ['CHANNEL_UNHOLD', 'unheld'],
      ['RECORD_START', 'recordingStarted'],
      ['RECORD_STOP', 'recordingStopped'],
    ] as const) {
      expect(
        normalizeEslEvent('fs-1', {
          'Event-Name': eventName,
          'Unique-ID': 'abc',
          'variable_sip_h_X-Tenant-Id': 'tenant-1',
        }),
      ).toEqual({ kind, callUuid: 'abc', nodeId: 'fs-1', tenantId: 'tenant-1' });
    }
  });

  it('takes the tenant from cuc_tenant_id when there is no X-Tenant-Id header (a call from a trunk, S5-08)', () => {
    expect(
      normalizeEslEvent('fs-1', {
        'Event-Name': 'CHANNEL_ANSWER',
        'Unique-ID': 'abc',
        'Event-Date-Timestamp': '1700000000000000',
        variable_cuc_tenant_id: 'tenant-2',
      }),
    ).toMatchObject({ kind: 'answered', tenantId: 'tenant-2' });
    // The header wins when both are there.
    expect(
      normalizeEslEvent('fs-1', {
        'Event-Name': 'CHANNEL_HOLD',
        'Unique-ID': 'abc',
        'variable_sip_h_X-Tenant-Id': 'tenant-1',
        variable_cuc_tenant_id: 'tenant-2',
      }),
    ).toMatchObject({ kind: 'held', tenantId: 'tenant-1' });
  });

  it('maps CHANNEL_HANGUP_COMPLETE to a hungup action with the hangup cause', () => {
    expect(
      normalizeEslEvent('fs-1', {
        'Event-Name': 'CHANNEL_HANGUP_COMPLETE',
        'Unique-ID': 'abc',
        'Hangup-Cause': 'USER_BUSY',
        'variable_sip_h_X-Tenant-Id': 'tenant-1',
      }),
    ).toEqual({
      kind: 'hungup',
      callUuid: 'abc',
      nodeId: 'fs-1',
      tenantId: 'tenant-1',
      hangupCause: 'USER_BUSY',
    });
  });

  it('maps HEARTBEAT to a heartbeat action regardless of Unique-ID', () => {
    expect(normalizeEslEvent('fs-1', { 'Event-Name': 'HEARTBEAT' })).toEqual({
      kind: 'heartbeat',
      nodeId: 'fs-1',
    });
  });

  it('ignores an event with no Unique-ID', () => {
    expect(normalizeEslEvent('fs-1', { 'Event-Name': 'CHANNEL_CREATE' })).toEqual({
      kind: 'ignored',
    });
  });

  it('ignores an event type it does not care about', () => {
    expect(
      normalizeEslEvent('fs-1', { 'Event-Name': 'CHANNEL_BRIDGE', 'Unique-ID': 'abc' }),
    ).toEqual({
      kind: 'ignored',
    });
  });

  it('maps a CUSTOM callcenter::info agent-state-change to queueAgentStateChanged (S2-13)', () => {
    const action = normalizeEslEvent('fs-1', {
      'Event-Name': 'CUSTOM',
      'Event-Subclass': 'callcenter::info',
      'CC-Action': 'agent-state-change',
      'CC-Agent': '101@acme.platform.test',
      'CC-Agent-Status': 'Available',
    });

    expect(action).toEqual({
      kind: 'queueAgentStateChanged',
      nodeId: 'fs-1',
      agentName: '101@acme.platform.test',
      status: 'Available',
    });
  });

  it('normalizes a callcenter event with no Unique-ID rather than dropping it (S2-13)', () => {
    // The whole point: unlike every other event type, this must not be
    // gated on Unique-ID being present.
    const action = normalizeEslEvent('fs-1', {
      'Event-Name': 'CUSTOM',
      'Event-Subclass': 'callcenter::info',
      'CC-Action': 'agent-state-change',
      'CC-Agent': '101@acme.platform.test',
      'CC-Agent-Status': 'Logged Out',
    });

    expect(action.kind).toBe('queueAgentStateChanged');
  });

  it('ignores a callcenter event with an unhandled CC-Action', () => {
    expect(
      normalizeEslEvent('fs-1', {
        'Event-Name': 'CUSTOM',
        'Event-Subclass': 'callcenter::info',
        'CC-Action': 'queue-member-add',
      }),
    ).toEqual({ kind: 'ignored' });
  });

  it('ignores a malformed agent-state-change missing CC-Agent/CC-Agent-Status', () => {
    expect(
      normalizeEslEvent('fs-1', {
        'Event-Name': 'CUSTOM',
        'Event-Subclass': 'callcenter::info',
        'CC-Action': 'agent-state-change',
      }),
    ).toEqual({ kind: 'ignored' });
  });

  it('ignores a CUSTOM event from an unrelated subclass', () => {
    expect(
      normalizeEslEvent('fs-1', {
        'Event-Name': 'CUSTOM',
        'Event-Subclass': 'conference::maintenance',
      }),
    ).toEqual({ kind: 'ignored' });
  });
});
