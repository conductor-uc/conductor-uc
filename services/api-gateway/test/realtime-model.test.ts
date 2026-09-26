import { describe, expect, it } from 'vitest';

import {
  callEventFromEnvelope,
  liveCallFromSnapshot,
  type LiveCall,
} from '../src/realtime/calls.js';
import { extensionOf, TenantPresence } from '../src/realtime/presence.js';
import { parseClientMessage } from '../src/realtime/protocol.js';
import { originAllowed } from '../src/realtime/route.js';
import { parseTopic, TOPICS } from '../src/realtime/topics.js';
import { UserCalls } from '../src/realtime/user-calls.js';

const TENANT = '0199a1b2-0000-7000-8000-000000000001';

/** An event envelope; `null` for one with no tenant. */
function envelope(type: string, data: object, tenantId: string | null = TENANT) {
  return {
    type,
    occurredAt: '2026-09-25T10:00:00.000Z',
    orgContext: tenantId === null ? {} : { tenantId },
    data,
  };
}

function call(overrides: Partial<LiveCall> = {}): LiveCall {
  return {
    callUuid: 'c1',
    direction: 'inbound',
    state: 'ringing',
    from: '101',
    to: '102',
    startedAt: '2026-09-25T10:00:00.000Z',
    answeredAt: null,
    bridgedTo: null,
    recording: 'off',
    controls: 'none',
    extension: null,
    ...overrides,
  };
}

describe('realtime protocol messages', () => {
  it('accepts auth, subscribe and unsubscribe', () => {
    expect(parseClientMessage('{"type":"auth","token":"t"}')).toEqual({
      ok: true,
      message: { type: 'auth', token: 't' },
    });
    expect(
      parseClientMessage(`{"type":"subscribe","topic":"tenant:${TENANT}:calls","id":"1"}`),
    ).toEqual({
      ok: true,
      message: { type: 'subscribe', topic: `tenant:${TENANT}:calls`, id: '1' },
    });
    expect(parseClientMessage('{"type":"unsubscribe","topic":"x"}')).toMatchObject({ ok: true });
  });

  it('refuses anything else, echoing a usable id', () => {
    expect(parseClientMessage('not json')).toEqual({ ok: false, code: 'bad_message' });
    expect(parseClientMessage('[]')).toEqual({ ok: false, code: 'bad_message' });
    expect(parseClientMessage('{"type":"auth"}')).toEqual({ ok: false, code: 'bad_message' });
    expect(parseClientMessage('{"type":"subscribe","topic":1,"id":"7"}')).toEqual({
      ok: false,
      code: 'bad_message',
      id: '7',
    });
    expect(parseClientMessage('{"type":"publish","id":"8"}')).toEqual({
      ok: false,
      code: 'unknown_type',
      id: '8',
    });
    expect(parseClientMessage('{"type":"auth","token":"t","id":5}')).toEqual({
      ok: false,
      code: 'bad_message',
    });
  });
});

describe('realtime topics', () => {
  it('parses the three tenant topics and nothing else', () => {
    expect(parseTopic(`tenant:${TENANT}:calls`)).toEqual({
      name: `tenant:${TENANT}:calls`,
      tenantId: TENANT,
      kind: 'calls',
    });
    expect(parseTopic(`tenant:${TENANT}:presence`)?.kind).toBe('presence');
    expect(parseTopic(`tenant:${TENANT}:queues`)?.kind).toBe('queues');
    for (const name of [
      `tenant:${TENANT}:recordings`,
      `reseller:${TENANT}:calls`,
      `tenant::calls`,
      `tenant:../x:calls`,
      `tenant:${TENANT}/y:calls`,
      `tenant:${TENANT}:calls:extra`,
      // S5-15: a person's own calls are only ever named with the person.
      `tenant:${TENANT}:mycalls`,
      `tenant:${TENANT}:user::calls`,
      `tenant:${TENANT}:user:u1:presence`,
      `tenant:${TENANT}:user:../u:calls`,
    ]) {
      expect(parseTopic(name), name).toBeUndefined();
    }
  });

  it('S5-15: parses a person own calls topic, private, on their own call history permission', () => {
    expect(parseTopic(`tenant:${TENANT}:user:u-1:calls`)).toEqual({
      name: `tenant:${TENANT}:user:u-1:calls`,
      tenantId: TENANT,
      kind: 'mycalls',
      userId: 'u-1',
    });
    expect(TOPICS.mycalls).toEqual({ permission: 'self.history', dataClass: 'private' });
  });

  it('declares a permission and a data class per topic; live calls are private', () => {
    expect(TOPICS.calls).toEqual({ permission: 'monitor.calls', dataClass: 'private' });
    expect(TOPICS.presence).toEqual({ permission: 'monitor.presence', dataClass: 'config' });
    expect(TOPICS.queues).toEqual({ permission: 'queue.read', dataClass: 'config' });
  });
});

describe('live call events', () => {
  it('maps call.channel.created to a started call without the node', () => {
    const mapped = callEventFromEnvelope(
      envelope('call.channel.created', {
        callUuid: 'c1',
        nodeId: 'fs-1',
        tenantId: TENANT,
        direction: 'outbound',
        from: '101',
        to: '+15551234567',
      }),
    );
    expect(mapped).toEqual({
      tenantId: TENANT,
      event: {
        type: 'call.started',
        call: {
          callUuid: 'c1',
          direction: 'outbound',
          state: 'ringing',
          from: '101',
          to: '+15551234567',
          startedAt: '2026-09-25T10:00:00.000Z',
          answeredAt: null,
          bridgedTo: null,
          recording: 'off',
          controls: 'none',
          extension: null,
        },
      },
    });
    expect(JSON.stringify(mapped)).not.toContain('fs-1');
  });

  it('S5-15: carries the vouched extension and the recording controls', () => {
    const mapped = callEventFromEnvelope(
      envelope('call.channel.created', {
        callUuid: 'c1',
        nodeId: 'fs-1',
        tenantId: TENANT,
        direction: 'inbound',
        from: '402',
        to: '401',
        extension: '402',
        controls: 'on_demand',
      }),
    );
    expect(mapped?.event).toMatchObject({
      type: 'call.started',
      call: { extension: '402', controls: 'on_demand' },
    });
    // Answer and bridge may say what the buttons can do now; an odd value is left out.
    expect(
      callEventFromEnvelope(
        envelope('call.channel.answered', { callUuid: 'c1', nodeId: 'fs-1', controls: 'pause' }),
      )?.event,
    ).toEqual({
      type: 'call.updated',
      callUuid: 'c1',
      changes: { state: 'answered', answeredAt: '2026-09-25T10:00:00.000Z', controls: 'pause' },
    });
    expect(
      callEventFromEnvelope(
        envelope('call.channel.bridged', {
          callUuid: 'c1',
          nodeId: 'fs-1',
          bridgedTo: 'c2',
          controls: 'bogus',
        }),
      )?.event,
    ).toEqual({ type: 'call.updated', callUuid: 'c1', changes: { bridgedTo: 'c2' } });
  });

  it('S5-15: a pause and a resume show as the recording being paused, then on again', () => {
    expect(
      callEventFromEnvelope(
        envelope('call.channel.recording_paused', { callUuid: 'c1', nodeId: 'fs-1' }),
      )?.event,
    ).toEqual({ type: 'call.updated', callUuid: 'c1', changes: { recording: 'paused' } });
    expect(
      callEventFromEnvelope(
        envelope('call.channel.recording_resumed', { callUuid: 'c1', nodeId: 'fs-1' }),
      )?.event,
    ).toEqual({ type: 'call.updated', callUuid: 'c1', changes: { recording: 'on' } });
    expect(
      liveCallFromSnapshot({
        callUuid: 'c1',
        direction: 'inbound',
        state: 'answered',
        from: '402',
        to: '401',
        startedAt: 1,
        answeredAt: 2,
        bridgedTo: null,
        recording: 'paused',
        controls: 'pause',
        extension: '402',
      }),
    ).toMatchObject({ recording: 'paused', controls: 'pause', extension: '402' });
  });

  it('maps call.channel.identified (a tenant learned mid-call) to a started call as it stands', () => {
    const mapped = callEventFromEnvelope(
      envelope('call.channel.identified', {
        callUuid: 'c1',
        nodeId: 'fs-1',
        tenantId: TENANT,
        direction: 'inbound',
        from: 'carrier',
        to: '+15551234567',
        state: 'answered',
        startedAt: '2026-09-25T09:59:58.000Z',
        answeredAt: '2026-09-25T09:59:59.000Z',
        bridgedTo: 'c2',
        recording: 'on',
      }),
    );
    expect(mapped).toEqual({
      tenantId: TENANT,
      event: {
        type: 'call.started',
        call: call({
          from: 'carrier',
          to: '+15551234567',
          state: 'answered',
          startedAt: '2026-09-25T09:59:58.000Z',
          answeredAt: '2026-09-25T09:59:59.000Z',
          bridgedTo: 'c2',
          recording: 'on',
        }),
      },
    });
    expect(JSON.stringify(mapped)).not.toContain('fs-1');
    expect(
      callEventFromEnvelope(envelope('call.channel.identified', { callUuid: 'c1', from: 'x' })),
    ).toBeUndefined();
  });

  it('maps every other channel event to an update or an end', () => {
    const base = { callUuid: 'c1', nodeId: 'fs-1' };
    const cases: [string, object, object][] = [
      [
        'call.channel.answered',
        base,
        {
          type: 'call.updated',
          callUuid: 'c1',
          changes: { state: 'answered', answeredAt: '2026-09-25T10:00:00.000Z' },
        },
      ],
      [
        'call.channel.bridged',
        { ...base, bridgedTo: 'c2' },
        { type: 'call.updated', callUuid: 'c1', changes: { bridgedTo: 'c2' } },
      ],
      [
        'call.channel.held',
        base,
        { type: 'call.updated', callUuid: 'c1', changes: { state: 'held' } },
      ],
      [
        'call.channel.unheld',
        base,
        { type: 'call.updated', callUuid: 'c1', changes: { state: 'answered' } },
      ],
      [
        'call.channel.recording_started',
        base,
        { type: 'call.updated', callUuid: 'c1', changes: { recording: 'on' } },
      ],
      [
        'call.channel.recording_stopped',
        base,
        { type: 'call.updated', callUuid: 'c1', changes: { recording: 'off' } },
      ],
      [
        'call.channel.hungup',
        { ...base, hangupCause: 'NORMAL_CLEARING' },
        { type: 'call.ended', callUuid: 'c1', hangupCause: 'NORMAL_CLEARING' },
      ],
    ];
    for (const [type, data, event] of cases) {
      expect(callEventFromEnvelope(envelope(type, data)), type).toEqual({
        tenantId: TENANT,
        event,
      });
    }
  });

  it('drops events with no tenant, of another kind, or of the wrong shape', () => {
    expect(
      callEventFromEnvelope(envelope('call.channel.held', { callUuid: 'c1' }, null)),
    ).toBeUndefined();
    expect(
      callEventFromEnvelope(
        envelope('call.queue.agent_status_changed', { nodeId: 'n', agentName: 'a', status: 's' }),
      ),
    ).toBeUndefined();
    expect(
      callEventFromEnvelope(envelope('call.channel.created', { callUuid: 'c1' })),
    ).toBeUndefined();
    expect(callEventFromEnvelope(envelope('call.channel.held', { callUuid: 7 }))).toBeUndefined();
    expect(
      callEventFromEnvelope({ ...envelope('call.channel.held', {}), data: null }),
    ).toBeUndefined();
  });

  it('reads a call-control snapshot entry, dropping what the topic does not carry', () => {
    expect(
      liveCallFromSnapshot({
        callUuid: 'c1',
        nodeId: 'fs-1',
        tenantId: TENANT,
        direction: 'inbound',
        state: 'answered',
        startedAt: Date.parse('2026-09-25T10:00:00.000Z'),
        answeredAt: Date.parse('2026-09-25T10:00:05.000Z'),
        from: '101',
        to: '102',
        bridgedTo: 'c2',
        recording: 'on',
      }),
    ).toEqual(
      call({
        state: 'answered',
        answeredAt: '2026-09-25T10:00:05.000Z',
        bridgedTo: 'c2',
        recording: 'on',
      }),
    );
    expect(liveCallFromSnapshot({ callUuid: 'c1' })).toBeUndefined();
  });
});

describe('presence from live calls', () => {
  it('takes the extension from the party the channel connects to, and never an outside number', () => {
    expect(extensionOf({ direction: 'inbound', from: '101', to: '+15551234567' })).toBe('101');
    expect(extensionOf({ direction: 'outbound', from: '+15550001111', to: '102' })).toBe('102');
    expect(extensionOf({ direction: 'inbound', from: '+15550001111', to: '102' })).toBeUndefined();
    expect(extensionOf({ direction: 'outbound', from: '101', to: '+15551234567' })).toBeUndefined();
    expect(extensionOf({ direction: 'inbound', from: '*45', to: '600' })).toBeUndefined();
  });

  it('follows an internal call from dialling to ringing to talking to idle', () => {
    const presence = new TenantPresence();
    presence.load([]);

    // 101 dials 102: the node gets an inbound leg from 101 ...
    expect(presence.apply({ type: 'call.started', call: call({ callUuid: 'a' }) })).toEqual([
      { type: 'presence.changed', extension: '101', state: 'on_call' },
    ]);
    // ... and rings 102 on an outbound leg.
    expect(
      presence.apply({
        type: 'call.started',
        call: call({ callUuid: 'b', direction: 'outbound', from: '101', to: '102' }),
      }),
    ).toEqual([{ type: 'presence.changed', extension: '102', state: 'ringing' }]);
    expect(presence.snapshot()).toEqual([
      { extension: '101', state: 'on_call' },
      { extension: '102', state: 'ringing' },
    ]);

    expect(
      presence.apply({ type: 'call.updated', callUuid: 'b', changes: { state: 'answered' } }),
    ).toEqual([{ type: 'presence.changed', extension: '102', state: 'on_call' }]);
    // A change that does not move the extension's state says nothing.
    expect(
      presence.apply({ type: 'call.updated', callUuid: 'a', changes: { state: 'answered' } }),
    ).toEqual([]);

    expect(
      presence.apply({ type: 'call.ended', callUuid: 'b', hangupCause: 'NORMAL_CLEARING' }),
    ).toEqual([{ type: 'presence.changed', extension: '102', state: 'idle' }]);
    expect(
      presence.apply({ type: 'call.ended', callUuid: 'a', hangupCause: 'NORMAL_CLEARING' }),
    ).toEqual([{ type: 'presence.changed', extension: '101', state: 'idle' }]);
    expect(presence.snapshot()).toEqual([]);
  });

  it('ignores calls between outside numbers and unknown channels', () => {
    const presence = new TenantPresence();
    presence.load([call({ callUuid: 'x', from: '+15550001111', to: '+15551234567' })]);
    expect(presence.snapshot()).toEqual([]);
    expect(presence.apply({ type: 'call.ended', callUuid: 'nope', hangupCause: 'X' })).toEqual([]);
  });
});

describe('realtime origin check', () => {
  const request = (origin: string | undefined, host = 'gw.example.test') => ({
    headers: origin === undefined ? {} : { origin },
    host,
  });

  it('allows the gateway own origin, a console hostname, and a non-browser client', () => {
    expect(originAllowed(request('https://gw.example.test'), [])).toBe(true);
    expect(originAllowed(request('https://console.brand.test'), ['console.brand.test'])).toBe(true);
    expect(originAllowed(request(undefined), [])).toBe(true);
  });

  it('refuses any other origin', () => {
    expect(originAllowed(request('https://evil.test'), ['console.brand.test'])).toBe(false);
    expect(originAllowed(request('https://gw.example.test:8443'), [])).toBe(false);
    expect(originAllowed(request('null'), [])).toBe(false);
    expect(originAllowed(request('file://gw.example.test'), [])).toBe(false);
  });
});

describe('a person own live calls (S5-15)', () => {
  const legs = (...calls: LiveCall[]) => new Map(calls.map((c) => [c.callUuid, c]));

  it('shows the legs on their extension and the legs bridged to them, never a caller ID match', () => {
    const view = new UserCalls('401');
    const all = legs(
      // 402 calls 401: the caller's leg (owns the recording) and the leg ringing 401.
      call({ callUuid: 'a', from: '402', to: '401', extension: '402', bridgedTo: 'b' }),
      call({ callUuid: 'b', direction: 'outbound', from: '402', to: '401', extension: '401' }),
      // A trunk caller whose caller ID is 401: not theirs.
      call({ callUuid: 'x', from: '401', to: '+15550100', extension: null }),
      // Someone else's call.
      call({ callUuid: 'y', from: '403', to: '404', extension: '403' }),
    );
    expect(
      view
        .load(all)
        .map((c) => c.callUuid)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('follows a call as it happens: their leg, then the caller leg when bridged, its recording, the end', () => {
    const view = new UserCalls('401');
    const all = legs();
    const step = (event: Parameters<UserCalls['apply']>[1]) => {
      if (event.type === 'call.started') all.set(event.call.callUuid, event.call);
      if (event.type === 'call.updated') {
        const leg = all.get(event.callUuid);
        if (leg !== undefined) all.set(event.callUuid, { ...leg, ...event.changes });
      }
      if (event.type === 'call.ended') all.delete(event.callUuid);
      return view.apply(all, event);
    };
    view.load(all);

    // The caller's leg is not theirs, so nothing yet.
    const a = call({ callUuid: 'a', from: '402', to: '401', extension: '402' });
    expect(step({ type: 'call.started', call: a })).toEqual([]);
    // Their phone rings.
    const b = call({ callUuid: 'b', direction: 'outbound', to: '401', extension: '401' });
    expect(step({ type: 'call.started', call: b })).toEqual([{ type: 'call.started', call: b }]);
    // Bridged: the caller's leg joins their view, as it stands now.
    const bridged = step({ type: 'call.updated', callUuid: 'a', changes: { bridgedTo: 'b' } });
    expect(bridged).toEqual([{ type: 'call.started', call: { ...a, bridgedTo: 'b' } }]);
    // Its recording pausing is theirs to see.
    expect(step({ type: 'call.updated', callUuid: 'a', changes: { recording: 'paused' } })).toEqual(
      [{ type: 'call.updated', callUuid: 'a', changes: { recording: 'paused' } }],
    );
    // Someone else's call is not.
    const other = call({ callUuid: 'y', extension: '403' });
    expect(step({ type: 'call.started', call: other })).toEqual([]);
    expect(step({ type: 'call.updated', callUuid: 'y', changes: { state: 'held' } })).toEqual([]);
    // Both legs end.
    expect(
      step({ type: 'call.ended', callUuid: 'b', hangupCause: 'NORMAL_CLEARING' }),
    ).toHaveLength(1);
    expect(
      step({ type: 'call.ended', callUuid: 'a', hangupCause: 'NORMAL_CLEARING' }),
    ).toHaveLength(1);
    expect(step({ type: 'call.ended', callUuid: 'y', hangupCause: 'NORMAL_CLEARING' })).toEqual([]);
  });

  it('a leg that starts already bridged to theirs is shown', () => {
    const view = new UserCalls('402');
    const mine = call({ callUuid: 'a', from: '402', to: '401', extension: '402' });
    const all = legs(mine);
    view.load(all);
    const theirs = call({ callUuid: 'b', direction: 'outbound', extension: '401', bridgedTo: 'a' });
    all.set('b', theirs);
    expect(view.apply(all, { type: 'call.started', call: theirs })).toEqual([
      { type: 'call.started', call: theirs },
    ]);
  });
});
