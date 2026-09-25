import { describe, expect, it } from 'vitest';
import { silentLogger } from '@cuc/testing';

import { createRecordingClient, type RecordingCall } from '../src/recording-client.js';

const call: RecordingCall = {
  tenantId: 'T1',
  direction: 'inbound',
  extensionIds: ['E2', 'E1'],
  queueId: 'Q1',
  didId: 'D1',
  callUuid: 'call-1',
  nodeId: 'fs-1',
};

interface Seen {
  path: string;
  body: Record<string, unknown>;
  auth: string | null;
}

/** A fake recording-service with switchable behaviour and a log of what it was asked. */
function fake() {
  const seen: Seen[] = [];
  const state = {
    decision: {
      record: true,
      announce: true,
      consentAssetId: 'A1' as string | null,
      policyId: 'P1' as string | null,
    },
    evaluateFails: false,
    registerFails: false,
    hang: false,
  };
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname.replace('/internal/v1/recordings/', '');
    seen.push({
      path,
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >,
      auth: new Headers(init?.headers).get('authorization'),
    });
    if (state.hang) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('timed out')));
      });
    }
    if (path === 'evaluate') {
      return Promise.resolve(
        state.evaluateFails
          ? new Response('{}', { status: 500 })
          : new Response(JSON.stringify(state.decision)),
      );
    }
    return Promise.resolve(
      state.registerFails
        ? new Response('{}', { status: 503 })
        : new Response(JSON.stringify({ recordingId: 'R1', fileName: 'R1.wav' })),
    );
  };
  return { seen, state, fetchImpl };
}

function client(f: ReturnType<typeof fake>, clock: { t: number }, overrides = {}) {
  return createRecordingClient({
    baseUrl: 'http://recording-service:8080/',
    internalServiceToken: 'tok',
    logger: silentLogger(),
    ttlMs: 30_000,
    maxStaleMs: 600_000,
    breakerMs: 5_000,
    timeoutMs: 100,
    fetchImpl: f.fetchImpl,
    now: () => clock.t,
    ...overrides,
  });
}

describe('recording client (S5-02)', () => {
  it('evaluates then registers a call to be recorded, sending the call context and the token', async () => {
    const f = fake();
    const directive = await client(f, { t: 0 }).decide(call);

    expect(directive).toEqual({
      kind: 'record',
      recordingId: 'R1',
      fileName: 'R1.wav',
      announce: true,
      consentAssetId: 'A1',
    });
    expect(f.seen.map((s) => s.path)).toEqual(['evaluate', 'register']);
    expect(f.seen[0]?.auth).toBe('Bearer tok');
    expect(f.seen[0]?.body).toMatchObject({
      tenantId: 'T1',
      direction: 'inbound',
      extensionIds: ['E2', 'E1'],
      queueId: 'Q1',
      didId: 'D1',
    });
    expect(f.seen[1]?.body).toMatchObject({
      tenantId: 'T1',
      callUuid: 'call-1',
      extensionId: 'E2',
      peerExtensionId: 'E1',
      queueId: 'Q1',
      didId: 'D1',
      policyId: 'P1',
      nodeId: 'fs-1',
      announced: true,
    });
  });

  it('answers "none" without registering anything when the policy says do not record', async () => {
    const f = fake();
    f.state.decision = { record: false, announce: false, consentAssetId: null, policyId: null };
    expect(await client(f, { t: 0 }).decide(call)).toEqual({ kind: 'none' });
    expect(f.seen.map((s) => s.path)).toEqual(['evaluate']);
  });

  it('caches a decision briefly (registering every call), and asks again after the ttl', async () => {
    const f = fake();
    const clock = { t: 0 };
    const c = client(f, clock);
    await c.decide(call);
    await c.decide({ ...call, callUuid: 'call-2', extensionIds: ['E1', 'E2'] }); // same call shape
    expect(f.seen.map((s) => s.path)).toEqual(['evaluate', 'register', 'register']);

    clock.t = 30_001;
    await c.decide(call);
    expect(f.seen.map((s) => s.path)).toEqual([
      'evaluate',
      'register',
      'register',
      'evaluate',
      'register',
    ]);

    // A different tenant, direction or queue is a different decision.
    await c.decide({ ...call, tenantId: 'T2' });
    await c.decide({ ...call, direction: 'outbound' });
    expect(f.seen.filter((s) => s.path === 'evaluate')).toHaveLength(4);
  });

  it('fails open: an unreachable service leaves the call unrecorded and counts it', async () => {
    const f = fake();
    f.state.evaluateFails = true;
    const c = client(f, { t: 0 });
    const directive = await c.decide(call);
    expect(directive).toMatchObject({ kind: 'unavailable' });
    expect(c.unavailableCount()).toBe(1);
  });

  it('fails open on a timeout, within the configured time', async () => {
    const f = fake();
    f.state.hang = true;
    const c = client(f, { t: 0 }, { timeoutMs: 50 });
    const started = Date.now();
    expect(await c.decide(call)).toMatchObject({ kind: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('fails open when the recording cannot be registered', async () => {
    const f = fake();
    f.state.registerFails = true;
    const c = client(f, { t: 0 });
    expect(await c.decide(call)).toMatchObject({ kind: 'unavailable' });
    expect(c.unavailableCount()).toBe(1);
  });

  it('after a failure, stops asking for a moment so an outage adds no delay to each call', async () => {
    const f = fake();
    f.state.evaluateFails = true;
    const clock = { t: 0 };
    const c = client(f, clock);
    await c.decide(call);
    await c.decide(call);
    await c.decide(call);
    expect(f.seen).toHaveLength(1);
    expect(c.unavailableCount()).toBe(3);

    clock.t = 5_001;
    f.state.evaluateFails = false;
    expect(await c.decide(call)).toMatchObject({ kind: 'record' });
  });

  it('keeps recording under the last known policy through a short outage, but not forever', async () => {
    const f = fake();
    const clock = { t: 0 };
    const c = client(f, clock);
    await c.decide(call); // fills the cache

    f.state.evaluateFails = true;
    clock.t = 60_000; // past the ttl: a refresh is attempted, fails, and the stale decision is used
    expect(await c.decide(call)).toMatchObject({ kind: 'record' });
    expect(c.unavailableCount()).toBe(0);

    clock.t = 601_000; // older than the stale limit
    expect(await c.decide(call)).toMatchObject({ kind: 'unavailable' });
  });

  it('a stale "do not record" is used the same way', async () => {
    const f = fake();
    f.state.decision = { record: false, announce: false, consentAssetId: null, policyId: null };
    const clock = { t: 0 };
    const c = client(f, clock);
    await c.decide(call);
    f.state.evaluateFails = true;
    clock.t = 40_000;
    expect(await c.decide(call)).toEqual({ kind: 'none' });
  });
});
