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
const TRUNK_SERVICE_URL = 'http://trunk-service:8080';
const RECORDING_SERVICE_URL = 'http://recording-service:8080';
const GATEWAY_CONTAINER = process.env['SIP_TEST_GATEWAY_CONTAINER'] ?? 'conductor-uc-api-gateway-1';
const CALLER_CONTAINER = 'sip-test-rt-caller';
const UAS_401 = 'sip-test-rt-uas-401';

type Message = Record<string, unknown> & { type: string };

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

/** A socket to the gateway's hub, collecting every message it gets. */
class HubClient {
  readonly messages: Message[] = [];
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      this.messages.push(JSON.parse(String(event.data)) as Message);
    });
  }

  static async open(url: string, token: string): Promise<HubClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`could not open ${url}`)), {
        once: true,
      });
    });
    const client = new HubClient(socket);
    client.send({ type: 'auth', token });
    await client.next((m) => m.type === 'authenticated');
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
      if (Date.now() > deadline) {
        throw new Error(`timed out; got ${JSON.stringify(this.messages)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async subscribe(topic: string): Promise<Message> {
    this.send({ type: 'subscribe', topic });
    const answer = await this.next(
      (m) => (m.type === 'subscribed' || m.type === 'error') && m['topic'] === topic,
    );
    expect(answer, JSON.stringify(answer)).toMatchObject({ type: 'subscribed' });
    return answer;
  }

  /** The `event` payloads received on `topic`, in order. */
  events(topic: string): Message[] {
    return this.messages
      .filter((m) => m.type === 'event' && m['topic'] === topic)
      .map((m) => m['event'] as Message);
  }

  close(): void {
    this.socket.close();
  }
}

/**
 * The realtime hub (S5-08), live: a person signs in through api-gateway the
 * way the console does, opens `/v1/ws`, and watches a real carrier call to
 * extension 401 (recorded by rule) go through FreeSWITCH. What only a real
 * node proves is that call-control's reading of FreeSWITCH's events (the
 * tenant of a trunk call learned mid-call, `RECORD_START`/`RECORD_STOP`)
 * reaches the tenant's subscribers as one consistent picture of the call.
 */
describe.skipIf(skipReason !== undefined)('realtime hub (live SIPp)', () => {
  let seed: SeedResult;
  let wsUrl: string;
  let accessToken: string;

  beforeAll(async () => {
    seed = await seedFixtures();
    const { stdout } = await execFileAsync('docker', [
      'inspect',
      GATEWAY_CONTAINER,
      '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}',
    ]);
    wsUrl = `ws://${stdout.trim().split(' ')[0] ?? ''}:8080/v1/ws`;

    // Sign in as a fresh tenant administrator, as the console does.
    const tenantId = seed.tenantVoicemail.id;
    const admin = await createSignInAdmin(tenantId, seed.resellerId);
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
      // An org that requires two-step verification: enrol, as the console does.
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

  async function ok<T = { id: string }>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    body: unknown,
    status: number,
  ): Promise<T> {
    const response = await dockerCurlJson(
      method,
      url,
      body,
      await tenantAdminHeaders(seed.tenantVoicemail.id, seed.resellerId),
    );
    expect(response.status, `${method} ${url}: ${JSON.stringify(response.json)}`).toBe(status);
    return response.json as T;
  }

  it('shows a recorded carrier call to its tenant: legs, answer, recording, presence and end', async () => {
    await withSingleFsNode(async () => {
      const tenantId = seed.tenantVoicemail.id;
      const callsTopic = `tenant:${tenantId}:calls`;
      const presenceTopic = `tenant:${tenantId}:presence`;
      const { rows } = await ok<{ rows: { id: string; number: string }[] }>(
        'GET',
        `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/extensions`,
        undefined,
        200,
      );
      const id401 = rows.find((row) => row.number === '401')?.id;
      if (id401 === undefined) throw new Error("no seeded extension '401'");
      const password = seed.extensions[`${seed.tenantVoicemail.fqdn}/401`]?.password ?? '';
      await clearRegistration(`401@${seed.tenantVoicemail.fqdn}`);

      const watcher = await HubClient.open(wsUrl, accessToken);
      let lateComer: HubClient | undefined;
      let policyId: string | undefined;
      let trunkId: string | undefined;
      let didId: string | undefined;
      try {
        await watcher.subscribe(callsTopic);
        await watcher.subscribe(presenceTopic);

        policyId = (
          await ok(
            'POST',
            `${RECORDING_SERVICE_URL}/v1/tenants/${tenantId}/recording-policies`,
            {
              scopeType: 'extension',
              scopeId: id401,
              direction: 'any',
              action: 'record',
              announce: false,
            },
            201,
          )
        ).id;

        const uas = startUas({
          au: '401',
          ap: password,
          authUri: seed.tenantVoicemail.fqdn,
          csvLine: `401;${seed.tenantVoicemail.fqdn}`,
          containerName: UAS_401,
        });
        await uas.ready();

        const e164 = `+1555997${String(Math.floor(1000 + Math.random() * 9000))}`;
        const caller = await startDelayedCaller({
          scenario: 'trunk_invite_hold.xml',
          csvLine: `carrier;opensips;${e164}`,
          containerName: CALLER_CONTAINER,
        });
        trunkId = (
          await ok(
            'POST',
            `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks`,
            {
              name: 'realtime trunk',
              authMode: 'ip',
              host: caller.ip,
              port: 5060,
              transport: 'udp',
              codecs: ['PCMU'],
            },
            201,
          )
        ).id;
        await ok(
          'POST',
          `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks/${trunkId}/ips`,
          { cidr: `${caller.ip}/32` },
          201,
        );
        didId = (
          await ok(
            'POST',
            `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/dids`,
            { e164, trunkId, destinationType: 'extension', destinationId: id401 },
            201,
          )
        ).id;

        // Someone who opens the page mid-call is given the call in the snapshot.
        await watcher.next(
          (m) =>
            m.type === 'event' &&
            m['topic'] === callsTopic &&
            (m['event'] as Message)['type'] === 'call.updated' &&
            ((m['event'] as Message)['changes'] as Record<string, unknown>)['state'] === 'answered',
          60_000,
        );
        lateComer = await HubClient.open(wsUrl, accessToken);
        await lateComer.subscribe(callsTopic);
        const snapshot = await lateComer.next((m) => m.type === 'snapshot');
        const snapshotCalls = (snapshot['data'] as { calls: Message[] }).calls;
        expect(snapshotCalls.length, JSON.stringify(snapshotCalls)).toBeGreaterThanOrEqual(2);
        expect(
          snapshotCalls.some((c) => c['recording'] === 'on'),
          JSON.stringify(snapshotCalls),
        ).toBe(true);

        const result = await caller.result();
        expect(result.successfulCalls, result.stdout).toBe(1);
        const answered = await uas.result();
        expect(answered.successfulCalls, answered.stdout).toBe(1);

        // Every leg the watcher heard about starts, and every one it heard start ends.
        const deadline = Date.now() + 15_000;
        let events = watcher.events(callsTopic);
        const started = () =>
          new Set(
            events
              .filter((e) => e['type'] === 'call.started')
              .map((e) => (e['call'] as Message)['callUuid'] as string),
          );
        const ended = () =>
          new Set(
            events.filter((e) => e['type'] === 'call.ended').map((e) => e['callUuid'] as string),
          );
        while (
          Date.now() < deadline &&
          (started().size < 2 || [...started()].some((uuid) => !ended().has(uuid)))
        ) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          events = watcher.events(callsTopic);
        }
        const summary = JSON.stringify(events, null, 1);
        expect(started().size, summary).toBeGreaterThanOrEqual(2);
        for (const uuid of started()) expect(ended().has(uuid), summary).toBe(true);
        const mentioned = new Set(
          events
            .filter((e) => e['type'] === 'call.updated' || e['type'] === 'call.ended')
            .map((e) => e['callUuid'] as string),
        );
        for (const uuid of mentioned) expect(started().has(uuid), `${uuid}\n${summary}`).toBe(true);

        // The carrier's number shows as the caller, and the call was recorded.
        const legs = events
          .filter((e) => e['type'] === 'call.started')
          .map((e) => e['call'] as Message);
        expect(
          legs.some((leg) => String(leg['to']).includes('401')),
          summary,
        ).toBe(true);
        const updates = events.filter((e) => e['type'] === 'call.updated');
        expect(
          updates.some((e) => (e['changes'] as Message)['bridgedTo'] !== undefined),
          summary,
        ).toBe(true);
        expect(
          updates.some((e) => (e['changes'] as Message)['recording'] === 'on'),
          summary,
        ).toBe(true);
        expect(
          updates.some((e) => (e['changes'] as Message)['recording'] === 'off'),
          summary,
        ).toBe(true);

        // 401 was on the call, and is idle again.
        const presence = watcher
          .events(presenceTopic)
          .filter((e) => e['extension'] === '401')
          .map((e) => e['state']);
        expect(presence, JSON.stringify(watcher.events(presenceTopic))).toContain('on_call');
        expect(presence.at(-1)).toBe('idle');

        // Nothing that is the media node's, and nothing for another tenant.
        expect(summary).not.toMatch(/nodeId|freeswitch/i);
      } finally {
        watcher.close();
        lateComer?.close();
        if (didId !== undefined) {
          await ok(
            'DELETE',
            `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/dids/${didId}`,
            undefined,
            204,
          ).catch(() => undefined);
        }
        if (trunkId !== undefined) {
          await ok(
            'DELETE',
            `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks/${trunkId}`,
            undefined,
            204,
          ).catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        if (policyId !== undefined) {
          await ok(
            'DELETE',
            `${RECORDING_SERVICE_URL}/v1/tenants/${tenantId}/recording-policies/${policyId}`,
            undefined,
            204,
          ).catch(() => undefined);
        }
      }
    });
  }, 240_000);
});
