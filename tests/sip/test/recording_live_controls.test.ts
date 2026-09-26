import { createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  clearRegistration,
  createSignInAdmin,
  dockerCurlJson,
  seedFixtures,
  sipInfraOrSkipReason,
  startDelayedCaller,
  startUas,
  stopContainer,
  tenantAdminHeaders,
  withSingleFsNode,
  type SeedResult,
} from '../src/run-scenario.js';

const execFileAsync = promisify(execFile);
const skipReason = await sipInfraOrSkipReason();

const GATEWAY_URL = 'http://api-gateway:8080';
const PBX_CONFIG_SERVICE_URL = 'http://pbx-config-service:8080';
const RECORDING_SERVICE_URL = 'http://recording-service:8080';
const IDENTITY_SERVICE_URL = 'http://identity-service:8080';
const GATEWAY_CONTAINER = process.env['SIP_TEST_GATEWAY_CONTAINER'] ?? 'conductor-uc-api-gateway-1';
const CALLER_CONTAINER = 'sip-test-livectl-caller';
const UAS_401 = 'sip-test-livectl-uas-401';

type Message = Record<string, unknown> & { type: string };

interface Leg {
  readonly callUuid: string;
  readonly direction: string;
  readonly state: string;
  readonly from: string;
  readonly to: string;
  readonly recording: string;
  readonly controls: string;
  readonly extension: string | null;
  readonly bridgedTo: string | null;
}

interface Recording {
  readonly id: string;
  readonly status: string;
  readonly sizeBytes: number | null;
  readonly onDemand: boolean;
  readonly stoppedAt: string | null;
  readonly pauses: readonly { from: string; to: string | null }[];
}

interface AuditEvent {
  readonly action: string;
  readonly resource: string;
  readonly actorType: string;
  readonly actorId: string;
}

/** RFC 6238 with the defaults identity-service enrols (SHA-1, 6 digits, 30 s). */
function totp(base32Secret: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of base32Secret.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  }
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const hmac = createHmac('sha1', bytes).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}

/**
 * A socket to the gateway's hub, keeping every message and, for one `calls` topic, the legs as
 * they stand now (the snapshot, then each change), the way the console's live calls panel does.
 */
class HubClient {
  readonly messages: Message[] = [];
  readonly legs = new Map<string, Leg>();

  private constructor(
    private readonly socket: WebSocket,
    private readonly topic: string,
  ) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as Message;
      this.messages.push(message);
      if (message['topic'] !== this.topic) return;
      if (message.type === 'snapshot') {
        this.legs.clear();
        for (const leg of (message['data'] as { calls: Leg[] }).calls) {
          this.legs.set(leg.callUuid, leg);
        }
      }
      if (message.type !== 'event') return;
      const change = message['event'] as {
        type: string;
        call?: Leg;
        callUuid?: string;
        changes?: Partial<Leg>;
      };
      if (change.type === 'call.started' && change.call !== undefined) {
        this.legs.set(change.call.callUuid, change.call);
      } else if (change.type === 'call.updated' && change.callUuid !== undefined) {
        const leg = this.legs.get(change.callUuid);
        if (leg !== undefined) this.legs.set(change.callUuid, { ...leg, ...change.changes });
      } else if (change.type === 'call.ended' && change.callUuid !== undefined) {
        this.legs.delete(change.callUuid);
      }
    });
  }

  static async open(url: string, token: string, topic: string): Promise<HubClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`could not open ${url}`)), {
        once: true,
      });
    });
    const client = new HubClient(socket, topic);
    client.send({ type: 'auth', token });
    await client.next((m) => m.type === 'authenticated');
    client.send({ type: 'subscribe', topic });
    const answer = await client.next(
      (m) => (m.type === 'subscribed' || m.type === 'error') && m['topic'] === topic,
    );
    expect(answer, JSON.stringify(answer)).toMatchObject({ type: 'subscribed' });
    await client.next((m) => m.type === 'snapshot' && m['topic'] === topic);
    return client;
  }

  send(message: object): void {
    this.socket.send(JSON.stringify(message));
  }

  async next(match: (m: Message) => boolean, timeoutMs = 10_000): Promise<Message> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(match);
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(this.messages)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Waits until a leg matches, and returns it. */
  async leg(match: (leg: Leg) => boolean, what: string, timeoutMs = 30_000): Promise<Leg> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = [...this.legs.values()].find(match);
      if (found !== undefined) return found;
      if (Date.now() > deadline) {
        throw new Error(`no leg ${what}; legs: ${JSON.stringify([...this.legs.values()])}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  close(): void {
    this.socket.close();
  }
}

/**
 * S5-15 (G-111 (3), G-120), live: the console's record, stop, pause and resume buttons, pressed
 * on a real call through api-gateway as a signed-in tenant administrator, with exactly the rules
 * of the in-call feature codes. 402 calls 401 (an internal call; `uac_call_hold_long.xml` holds it
 * for 45 s) under a rule for 401, and the test acts while it is up:
 *
 * - A rule that does not record but allows on demand: the call says `controls: on_demand`;
 *   Start starts an on-demand recording (the hub shows it on), a second Start is refused (409),
 *   Stop stops it (the hub shows it off). The recording is uploaded, marked on demand and
 *   stopped, and both actions are audited as the administrator (actor type `user`).
 * - A rule that records and allows on demand: `controls: pause`; Stop is refused (a rule
 *   recording is never stopped), Pause shows `paused` on the hub, Resume shows `on` again. The
 *   recording has one closed pause, and both are audited as the administrator.
 * - A rule that does not allow on demand: `controls: none`, and Start is refused (409
 *   `recording_not_allowed`) with nothing recorded.
 *
 * The buttons are pressed on the called party's leg (401's), so call-control must find the call's
 * owner channel (the caller's leg) itself.
 *
 * Needs the stack rebuilt from this branch: call-control (the routes, `cuc::recording`),
 * api-gateway (the route table, the hub's `paused` and `controls`), recording-service (explicit
 * actions), telephony-config and the FreeSWITCH image (`cuc_rec_controls`,
 * `recording_control.lua`), and identity-service (the built-in roles now carry
 * `recording.control`). Unverified until run: `sendevent` of a CUSTOM event over ESL coming back
 * to call-control's own subscription, and `uuid_record mask` on a recording started with
 * `execute_on_answer=record_session`.
 */
describe.skipIf(skipReason !== undefined)('S5-15 live recording buttons (live SIPp)', () => {
  let seed: SeedResult;
  let wsUrl: string;
  let accessToken: string;
  let adminUserId: string;

  beforeAll(async () => {
    seed = await seedFixtures();
    const { stdout } = await execFileAsync('docker', [
      'inspect',
      GATEWAY_CONTAINER,
      '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}',
    ]);
    wsUrl = `ws://${stdout.trim().split(' ')[0] ?? ''}:8080/v1/ws`;

    // A fresh tenant administrator, signed in through the gateway as the console does.
    const tenantId = seed.tenantVoicemail.id;
    const admin = await createSignInAdmin(tenantId, seed.resellerId);
    adminUserId = admin.userId;
    const login = await dockerCurlJson('POST', `${GATEWAY_URL}/v1/auth/login`, {
      orgId: tenantId,
      email: admin.email,
      password: admin.password,
    });
    expect(login.status, JSON.stringify(login.json)).toBe(200);
    const signedIn = login.json as {
      status: string;
      accessToken?: string;
      enrollmentTicket?: string;
      totp?: { secret: string };
    };
    if (signedIn.status === 'ok') {
      accessToken = signedIn.accessToken ?? '';
    } else {
      expect(signedIn.status).toBe('mfa_enrollment_required');
      const confirmed = await dockerCurlJson('POST', `${GATEWAY_URL}/v1/auth/mfa/enroll/confirm`, {
        enrollmentTicket: signedIn.enrollmentTicket,
        code: totp(signedIn.totp?.secret ?? ''),
      });
      expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
      accessToken = (confirmed.json as { accessToken: string }).accessToken;
    }
    expect(accessToken).not.toBe('');
  }, 120_000);

  afterEach(async () => {
    await stopContainer(CALLER_CONTAINER);
    await stopContainer(UAS_401);
  });

  /** A call made as the tenant administrator, with signed headers straight to a service. */
  async function asAdmin(method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown) {
    return dockerCurlJson(
      method,
      url,
      body,
      await tenantAdminHeaders(seed.tenantVoicemail.id, seed.resellerId),
    );
  }

  async function ok<T = { id: string }>(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    body: unknown,
    status: number,
  ): Promise<T> {
    const response = await asAdmin(method, url, body);
    expect(response.status, `${method} ${url}: ${JSON.stringify(response.json)}`).toBe(status);
    return response.json as T;
  }

  /** Presses a recording button through api-gateway, as the signed-in administrator. */
  async function press(callUuid: string, action: 'start' | 'stop' | 'pause' | 'resume') {
    return dockerCurlJson(
      'POST',
      `${GATEWAY_URL}/v1/tenants/${seed.tenantVoicemail.id}/calls/${callUuid}/recording`,
      { action },
      { authorization: `Bearer ${accessToken}` },
    );
  }

  async function extensionId(number: string): Promise<string> {
    const { rows } = await ok<{ rows: { id: string; number: string }[] }>(
      'GET',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${seed.tenantVoicemail.id}/extensions`,
      undefined,
      200,
    );
    const found = rows.find((row) => row.number === number);
    if (found === undefined) throw new Error(`no seeded extension '${number}'`);
    return found.id;
  }

  function password(number: string): string {
    const entry = seed.extensions[`${seed.tenantVoicemail.fqdn}/${number}`];
    if (entry === undefined) throw new Error(`no seeded extension ${number}`);
    return entry.password;
  }

  async function recordingsSince(id401: string, since: Date): Promise<Recording[]> {
    const { rows } = await ok<{ rows: Recording[] }>(
      'GET',
      `${RECORDING_SERVICE_URL}/v1/tenants/${seed.tenantVoicemail.id}/recordings?extensionId=${id401}&from=${since.toISOString()}`,
      undefined,
      200,
    );
    return rows;
  }

  async function readyRecordingsSince(id401: string, since: Date): Promise<Recording[]> {
    const deadline = Date.now() + 120_000;
    let last: Recording[] = [];
    while (Date.now() < deadline) {
      last = await recordingsSince(id401, since);
      if (last.length > 0 && last.every((r) => r.status === 'ready')) return last;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw new Error(`no ready recording; last seen: ${JSON.stringify(last)}`);
  }

  async function auditFor(resource: string, actions: string[]): Promise<AuditEvent[]> {
    const deadline = Date.now() + 30_000;
    let found: AuditEvent[] = [];
    while (Date.now() < deadline) {
      const response = await asAdmin(
        'GET',
        `${IDENTITY_SERVICE_URL}/v1/orgs/${seed.tenantVoicemail.id}/audit-events?limit=200`,
      );
      expect(response.status, JSON.stringify(response.json)).toBe(200);
      found = (response.json as { rows: AuditEvent[] }).rows.filter(
        (event) => event.resource === resource,
      );
      if (actions.every((action) => found.some((event) => event.action === action))) return found;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`audit trail for ${resource} is missing some of ${actions.join(', ')}`);
  }

  /**
   * 402 calls 401 under `rule` for 401 and holds the call; `during` acts on it once 401's leg is
   * answered on the hub; `after` checks what was stored once the call has ended.
   */
  async function scenario(options: {
    rule: Record<string, unknown>;
    during: (hub: HubClient, leg401: Leg) => Promise<void>;
    after: (ids: { id401: string; since: Date }) => Promise<void>;
  }): Promise<void> {
    await withSingleFsNode(async () => {
      const tenantId = seed.tenantVoicemail.id;
      const fqdn = seed.tenantVoicemail.fqdn;
      const id401 = await extensionId('401');
      await clearRegistration(`401@${fqdn}`);
      await clearRegistration(`402@${fqdn}`);
      let policyId: string | undefined;
      const hub = await HubClient.open(wsUrl, accessToken, `tenant:${tenantId}:calls`);
      try {
        policyId = (
          await ok(
            'POST',
            `${RECORDING_SERVICE_URL}/v1/tenants/${tenantId}/recording-policies`,
            { scopeType: 'extension', scopeId: id401, direction: 'any', ...options.rule },
            201,
          )
        ).id;

        const uas = startUas({
          au: '401',
          ap: password('401'),
          authUri: fqdn,
          csvLine: `401;${fqdn}`,
          containerName: UAS_401,
          answerScenario: 'answer_call_dtmf.xml',
        });
        await uas.ready();

        const since = new Date(Date.now() - 1000);
        const caller = await startDelayedCaller({
          scenario: 'uac_call_hold_long.xml',
          csvLine: `402;${fqdn};401`,
          au: '402',
          ap: password('402'),
          authUri: fqdn,
          containerName: CALLER_CONTAINER,
        });

        // 401's own leg (the one the node placed to ring it), once answered and bridged.
        const leg401 = await hub.leg(
          (leg) => leg.extension === '401' && leg.state === 'answered' && leg.bridgedTo !== null,
          'for 401, answered and bridged',
          40_000,
        );
        await options.during(hub, leg401);

        const result = await caller.result();
        expect(result.successfulCalls, result.stdout).toBe(1);
        const answered = await uas.result();
        expect(answered.successfulCalls, answered.stdout).toBe(1);

        await options.after({ id401, since });
        // The hub never names the media node.
        expect(JSON.stringify(hub.messages)).not.toMatch(/nodeId|freeswitch/i);
      } finally {
        hub.close();
        if (policyId !== undefined) {
          await asAdmin(
            'DELETE',
            `${RECORDING_SERVICE_URL}/v1/tenants/${tenantId}/recording-policies/${policyId}`,
          );
        }
      }
    });
  }

  /** The recording state of the call `leg` is on (either of its legs), as the hub shows it. */
  const recordingOf = (hub: HubClient, leg: Leg): string[] =>
    [hub.legs.get(leg.callUuid), leg.bridgedTo === null ? undefined : hub.legs.get(leg.bridgedTo)]
      .filter((l): l is Leg => l !== undefined)
      .map((l) => l.recording);

  async function until(check: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it('Start and Stop an on-demand recording where the rule allows it; audited as the person', async () => {
    let recordingId = '';
    await scenario({
      rule: { action: 'no_record', allowOnDemand: true },
      during: async (hub, leg401) => {
        expect(leg401.controls).toBe('on_demand');
        expect(recordingOf(hub, leg401)).not.toContain('on');

        const started = await press(leg401.callUuid, 'start');
        expect(started.status, JSON.stringify(started.json)).toBe(200);
        expect(started.json).toMatchObject({ result: 'started', recording: 'on' });
        recordingId = (started.json as { recordingId: string }).recordingId;
        await until(() => recordingOf(hub, leg401).includes('on'), 'the recording to show on');

        const again = await press(leg401.callUuid, 'start');
        expect(again.status, JSON.stringify(again.json)).toBe(409);
        expect(again.json).toMatchObject({ code: 'already_recording' });

        await new Promise((resolve) => setTimeout(resolve, 3000));
        const stopped = await press(leg401.callUuid, 'stop');
        expect(stopped.status, JSON.stringify(stopped.json)).toBe(200);
        expect(stopped.json).toMatchObject({ result: 'stopped', recordingId, recording: 'off' });
        await until(() => !recordingOf(hub, leg401).includes('on'), 'the recording to show off');
      },
      after: async ({ id401, since }) => {
        const ready = await readyRecordingsSince(id401, since);
        expect(ready).toHaveLength(1);
        const recording = ready[0]!;
        expect(recording.id).toBe(recordingId);
        expect(recording.onDemand).toBe(true);
        expect(recording.stoppedAt).not.toBeNull();
        expect(recording.sizeBytes ?? 0).toBeGreaterThan(44);

        const events = await auditFor(`recording:${recording.id}`, [
          'recording.on_demand.started',
          'recording.on_demand.stopped',
        ]);
        for (const event of events) {
          expect(event).toMatchObject({ actorType: 'user', actorId: adminUserId });
        }
      },
    });
  }, 300_000);

  it('Pause and Resume a rule recording where the rule allows it; Stop is refused', async () => {
    await scenario({
      rule: { action: 'record', allowOnDemand: true },
      during: async (hub, leg401) => {
        expect(leg401.controls).toBe('pause');
        await until(() => recordingOf(hub, leg401).includes('on'), 'the rule recording to start');

        const stop = await press(leg401.callUuid, 'stop');
        expect(stop.status, JSON.stringify(stop.json)).toBe(409);
        expect(stop.json).toMatchObject({ code: 'rule_recording' });

        const paused = await press(leg401.callUuid, 'pause');
        expect(paused.status, JSON.stringify(paused.json)).toBe(200);
        expect(paused.json).toMatchObject({ result: 'paused', recording: 'paused' });
        await until(
          () => recordingOf(hub, leg401).includes('paused'),
          'the hub to show the recording paused',
        );

        await new Promise((resolve) => setTimeout(resolve, 3000));
        const resumed = await press(leg401.callUuid, 'resume');
        expect(resumed.status, JSON.stringify(resumed.json)).toBe(200);
        expect(resumed.json).toMatchObject({ result: 'resumed', recording: 'on' });
        await until(
          () =>
            recordingOf(hub, leg401).includes('on') && !recordingOf(hub, leg401).includes('paused'),
          'the hub to show the recording on again',
        );
      },
      after: async ({ id401, since }) => {
        const ready = await readyRecordingsSince(id401, since);
        expect(ready).toHaveLength(1);
        const recording = ready[0]!;
        expect(recording.onDemand).toBe(false);
        expect(recording.pauses).toHaveLength(1);
        expect(recording.pauses[0]!.to).not.toBeNull();
        expect(recording.sizeBytes ?? 0).toBeGreaterThan(44);

        const events = await auditFor(`recording:${recording.id}`, [
          'recording.paused',
          'recording.resumed',
        ]);
        for (const event of events.filter((e) => e.action.startsWith('recording.'))) {
          expect(event).toMatchObject({ actorType: 'user', actorId: adminUserId });
        }
      },
    });
  }, 300_000);

  it('Start is refused where no rule allows on demand, and nothing is recorded', async () => {
    await scenario({
      rule: { action: 'no_record', allowOnDemand: false },
      during: async (_hub, leg401) => {
        expect(leg401.controls).toBe('none');
        const refused = await press(leg401.callUuid, 'start');
        expect(refused.status, JSON.stringify(refused.json)).toBe(409);
        expect(refused.json).toMatchObject({ code: 'recording_not_allowed' });
        expect(JSON.stringify(refused.json)).not.toMatch(/freeswitch|uuid_/i);
      },
      after: async ({ id401, since }) => {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        expect(await recordingsSince(id401, since)).toEqual([]);
      },
    });
  }, 300_000);
});
