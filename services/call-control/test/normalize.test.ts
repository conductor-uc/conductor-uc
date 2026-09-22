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
      },
    });
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
    ).toEqual({ kind: 'bridged', callUuid: 'abc', nodeId: 'fs-1', bridgedTo: 'def' });
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
      },
    );
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
});
