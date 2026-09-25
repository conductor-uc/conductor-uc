import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  clearRegistration,
  dockerCurlJson,
  dockerCurlText,
  seedFixtures,
  sipInfraOrSkipReason,
  sipTestEnv,
  startDelayedCaller,
  startUas,
  stopContainer,
  tenantAdminHeaders,
  withSingleFsNode,
  type SeedResult,
} from '../src/run-scenario.js';

const execFileAsync = promisify(execFile);
const skipReason = await sipInfraOrSkipReason();

const PBX_CONFIG_SERVICE_URL = 'http://pbx-config-service:8080';
const TRUNK_SERVICE_URL = 'http://trunk-service:8080';
const RECORDING_SERVICE_URL = 'http://recording-service:8080';
const CARRIER_TARGET_DOMAIN = 'opensips';
const CALLER_CONTAINER = 'sip-test-rec-caller';
const UAS_401 = 'sip-test-rec-uas-401';
const SPOOL_DIR = '/var/spool/cuc/rec';

interface Recording {
  readonly id: string;
  readonly didId: string | null;
  readonly extensionId: string | null;
  readonly direction: string;
  readonly announced: boolean;
  readonly status: string;
  readonly durationMs: number | null;
  readonly sizeBytes: number | null;
}

/**
 * Call recording (S5-02, S5-03), live: a carrier call through a DID to
 * extension 401 while 401 has a recording rule. What these prove on a real
 * node is the whole pipeline: telephony-config asks recording-service at call
 * setup, FreeSWITCH records to the spool, the node's uploader sidecar puts the
 * file in the tenant's bucket through recording-service and deletes it from
 * the spool, and the recording can then be found and played.
 */
describe.skipIf(skipReason !== undefined)('call recording (live SIPp)', () => {
  let seed: SeedResult;

  beforeAll(async () => {
    seed = await seedFixtures();
  }, 60_000);

  afterEach(async () => {
    await stopContainer(CALLER_CONTAINER);
    await stopContainer(UAS_401);
  });

  async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) {
    return dockerCurlJson(
      method,
      url,
      body,
      await tenantAdminHeaders(seed.tenantVoicemail.id, seed.resellerId),
    );
  }

  async function ok<T = { id: string }>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    body: unknown,
    status: number,
  ): Promise<T> {
    const response = await call(method, url, body);
    expect(response.status, `${method} ${url}: ${JSON.stringify(response.json)}`).toBe(status);
    return response.json as T;
  }

  async function extensionId(tenantId: string, number: string): Promise<string> {
    const { rows } = await ok<{ rows: { id: string; number: string }[] }>(
      'GET',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/extensions`,
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

  async function recordingsForDid(tenantId: string, didId: string): Promise<Recording[]> {
    const { rows } = await ok<{ rows: Recording[] }>(
      'GET',
      `${RECORDING_SERVICE_URL}/v1/tenants/${tenantId}/recordings?didId=${didId}`,
      undefined,
      200,
    );
    return rows;
  }

  /** The uploader waits for a file to settle (30 s in compose), then uploads it. */
  async function waitForReady(tenantId: string, didId: string): Promise<Recording> {
    const deadline = Date.now() + 120_000;
    let last: Recording[] = [];
    while (Date.now() < deadline) {
      last = await recordingsForDid(tenantId, didId);
      const ready = last.find((r) => r.status === 'ready');
      if (ready !== undefined) return ready;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw new Error(`no ready recording for the DID; last seen: ${JSON.stringify(last)}`);
  }

  async function spoolListing(): Promise<string[]> {
    const { stdout } = await execFileAsync('docker', [
      'exec',
      sipTestEnv().freeswitchContainer,
      'ls',
      '-A',
      SPOOL_DIR,
    ]);
    return stdout.split('\n').filter((name) => name !== '');
  }

  /**
   * A carrier call to a fresh DID pointing at extension 401 (registered and
   * answering), with 401 under the given recording rule. Returns the DID so
   * the test can find the call's recordings, and always cleans up.
   */
  async function scenario(options: {
    rule: Record<string, unknown> | null;
    caller?: string;
    check: (ids: { tenantId: string; didId: string; id401: string }) => Promise<void>;
  }): Promise<void> {
    await withSingleFsNode(async () => {
      const tenantId = seed.tenantVoicemail.id;
      const id401 = await extensionId(tenantId, '401');
      await clearRegistration(`401@${seed.tenantVoicemail.fqdn}`);

      let policyId: string | undefined;
      let trunkId: string | undefined;
      let didId: string | undefined;
      try {
        if (options.rule !== null) {
          const policy = await ok(
            'POST',
            `${RECORDING_SERVICE_URL}/v1/tenants/${tenantId}/recording-policies`,
            { scopeType: 'extension', scopeId: id401, direction: 'any', ...options.rule },
            201,
          );
          policyId = policy.id;
        }

        const uas = startUas({
          au: '401',
          ap: password('401'),
          authUri: seed.tenantVoicemail.fqdn,
          csvLine: `401;${seed.tenantVoicemail.fqdn}`,
          containerName: UAS_401,
        });
        await uas.ready();

        const e164 = `+1555996${String(Math.floor(1000 + Math.random() * 9000))}`;
        const caller = await startDelayedCaller({
          scenario: options.caller ?? 'trunk_invite_hold.xml',
          csvLine: `carrier;${CARRIER_TARGET_DOMAIN};${e164}`,
          containerName: CALLER_CONTAINER,
        });
        const trunk = await ok(
          'POST',
          `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks`,
          {
            name: 'recording trunk',
            authMode: 'ip',
            host: caller.ip,
            port: 5060,
            transport: 'udp',
            codecs: ['PCMU'],
          },
          201,
        );
        trunkId = trunk.id;
        await ok(
          'POST',
          `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks/${trunkId}/ips`,
          { cidr: `${caller.ip}/32` },
          201,
        );
        const did = await ok(
          'POST',
          `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/dids`,
          { e164, trunkId, destinationType: 'extension', destinationId: id401 },
          201,
        );
        didId = did.id;

        const result = await caller.result();
        expect(result.successfulCalls, result.stdout).toBe(1);
        const answered = await uas.result();
        expect(answered.successfulCalls, answered.stdout).toBe(1);

        await options.check({ tenantId, didId, id401 });
      } finally {
        if (didId !== undefined) {
          await call('DELETE', `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/dids/${didId}`);
        }
        if (trunkId !== undefined) {
          await call('DELETE', `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks/${trunkId}`);
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        if (policyId !== undefined) {
          await call(
            'DELETE',
            `${RECORDING_SERVICE_URL}/v1/tenants/${tenantId}/recording-policies/${policyId}`,
          );
        }
      }
    });
  }

  it('records a call to an extension with a recording rule, uploads it, and empties the spool', async () => {
    await scenario({
      rule: { action: 'record', announce: false },
      check: async ({ tenantId, didId, id401 }) => {
        const recording = await waitForReady(tenantId, didId);
        expect(recording).toMatchObject({
          didId,
          extensionId: id401,
          direction: 'inbound',
          announced: false,
        });
        expect(recording.sizeBytes ?? 0).toBeGreaterThan(44);

        const { url } = await ok<{ url: string }>(
          'GET',
          `${RECORDING_SERVICE_URL}/v1/tenants/${tenantId}/recordings/${recording.id}/play-url`,
          undefined,
          200,
        );
        const audio = await dockerCurlText(url);
        expect(audio.status).toBe(200);
        expect(audio.text.startsWith('RIFF')).toBe(true);

        // Nothing durable on the node (CLAUDE.md rule 5): the uploader deleted its copy.
        expect(await spoolListing()).not.toContain(`${recording.id}.wav`);
      },
    });
  }, 240_000);

  it('does not record a call to an extension whose rule says not to', async () => {
    await scenario({
      rule: { action: 'no_record', announce: false },
      check: async ({ tenantId, didId }) => {
        // Long enough for a recording, had there been one, to have been registered at call setup.
        await new Promise((resolve) => setTimeout(resolve, 3000));
        expect(await recordingsForDid(tenantId, didId)).toEqual([]);
      },
    });
  }, 240_000);

  it('announces the recording as early media before the call is answered, then records it', async () => {
    await scenario({
      caller: 'trunk_invite_hold_early_media.xml',
      rule: { action: 'record', announce: true },
      check: async ({ tenantId, didId }) => {
        const recording = await waitForReady(tenantId, didId);
        expect(recording.announced).toBe(true);
      },
    });
  }, 240_000);
});
