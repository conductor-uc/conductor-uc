import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  clearRegistration,
  dockerCurlJson,
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

const CALLFLOW_SERVICE_URL = 'http://callflow-service:8080';
const PBX_CONFIG_SERVICE_URL = 'http://pbx-config-service:8080';
const TRUNK_SERVICE_URL = 'http://trunk-service:8080';
const RECORDING_SERVICE_URL = 'http://recording-service:8080';
const CARRIER_TARGET_DOMAIN = 'opensips';
const CALLER_CONTAINER = 'sip-test-recflow-caller';
const UAS_401 = 'sip-test-recflow-uas-401';
const SPOOL_DIR = '/var/spool/cuc/rec';

interface Recording {
  readonly id: string;
  readonly didId: string | null;
  readonly extensionId: string | null;
  readonly direction: string;
  readonly status: string;
  readonly sizeBytes: number | null;
}

/**
 * S5-11 (G-111), live: calls that enter through an IVR flow are recorded, at both layers.
 *
 * A carrier call reaches a DID bound to a published flow whose only node is an `extension` node
 * for 401 (registered, answering). Three cases:
 *
 * - (i) a DID rule: decided at flow entry by `/fs/dialplan` (tenant and DID rules), armed with
 *   `execute_on_answer`, so the recording starts when the flow answers. The flow's hand-off then
 *   says the call is already recorded (`recording=1`), so there is exactly one recording.
 * - (ii) only an extension rule for 401: nothing at flow entry; `flow_runner.lua` asks for 401
 *   with the call's DID, telephony-config decides for the extension and returns a recording
 *   instruction, and the runner arms it on the bridge (`api_on_answer` → `uuid_record`).
 * - (iii) no rule: nothing is recorded.
 *
 * Needs the FreeSWITCH image rebuilt with this branch's `flow_runner.lua`.
 */
describe.skipIf(skipReason !== undefined)(
  'S5-11 recording calls through an IVR flow (live SIPp)',
  () => {
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
    async function waitForReady(tenantId: string, didId: string): Promise<Recording[]> {
      const deadline = Date.now() + 120_000;
      let last: Recording[] = [];
      while (Date.now() < deadline) {
        last = await recordingsForDid(tenantId, didId);
        if (last.length > 0 && last.every((r) => r.status === 'ready')) return last;
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
     * A carrier call to a fresh DID bound to a fresh flow that hands the call to 401. `rule` is
     * created once the DID exists (so a DID rule can name it), before the caller's INVITE (the
     * scenario pauses 6 s first). Always cleans up.
     */
    async function scenario(options: {
      rule: 'did' | 'extension' | null;
      check: (ids: { tenantId: string; didId: string; id401: string }) => Promise<void>;
    }): Promise<void> {
      await withSingleFsNode(async () => {
        const tenantId = seed.tenantVoicemail.id;
        const id401 = await extensionId(tenantId, '401');
        await clearRegistration(`401@${seed.tenantVoicemail.fqdn}`);

        let flowId: string | undefined;
        let trunkId: string | undefined;
        let didId: string | undefined;
        let policyId: string | undefined;
        try {
          const flow = await ok(
            'POST',
            `${CALLFLOW_SERVICE_URL}/v1/tenants/${tenantId}/flows`,
            { name: 'S5-11 recording flow' },
            201,
          );
          flowId = flow.id;
          await ok(
            'PUT',
            `${CALLFLOW_SERVICE_URL}/v1/tenants/${tenantId}/flows/${flowId}/draft`,
            {
              entryPoints: { main: 'ext' },
              nodes: [
                {
                  id: 'ext',
                  type: 'extension',
                  config: { extensionId: id401, ringSeconds: 20 },
                  position: { x: 0, y: 0 },
                },
                { id: 'bye', type: 'hangup', config: {}, position: { x: 200, y: 0 } },
              ],
              edges: [{ from: 'ext', port: 'noAnswer', to: 'bye' }],
            },
            200,
          );
          await ok(
            'POST',
            `${CALLFLOW_SERVICE_URL}/v1/tenants/${tenantId}/flows/${flowId}/publish`,
            {},
            201,
          );

          const uas = startUas({
            au: '401',
            ap: password('401'),
            authUri: seed.tenantVoicemail.fqdn,
            csvLine: `401;${seed.tenantVoicemail.fqdn}`,
            containerName: UAS_401,
          });
          await uas.ready();

          const e164 = `+1555994${String(Math.floor(1000 + Math.random() * 9000))}`;
          const caller = await startDelayedCaller({
            scenario: 'trunk_invite_hold.xml',
            csvLine: `carrier;${CARRIER_TARGET_DOMAIN};${e164}`,
            containerName: CALLER_CONTAINER,
          });
          const trunk = await ok(
            'POST',
            `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks`,
            {
              name: 'S5-11 flow recording trunk',
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
            { e164, trunkId, destinationType: 'flow', destinationId: flowId },
            201,
          );
          didId = did.id;

          if (options.rule !== null) {
            const policy = await ok(
              'POST',
              `${RECORDING_SERVICE_URL}/v1/tenants/${tenantId}/recording-policies`,
              {
                scopeType: options.rule,
                scopeId: options.rule === 'did' ? didId : id401,
                direction: 'any',
                action: 'record',
                announce: false,
              },
              201,
            );
            policyId = policy.id;
          }

          const result = await caller.result();
          expect(result.successfulCalls, result.stdout).toBe(1);
          const answered = await uas.result();
          expect(answered.successfulCalls, answered.stdout).toBe(1);

          await options.check({ tenantId, didId, id401 });
        } finally {
          if (policyId !== undefined) {
            await call(
              'DELETE',
              `${RECORDING_SERVICE_URL}/v1/tenants/${tenantId}/recording-policies/${policyId}`,
            );
          }
          if (didId !== undefined) {
            await call('DELETE', `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/dids/${didId}`);
          }
          if (trunkId !== undefined) {
            await call('DELETE', `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks/${trunkId}`);
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
          if (flowId !== undefined) {
            await call('DELETE', `${CALLFLOW_SERVICE_URL}/v1/tenants/${tenantId}/flows/${flowId}`);
          }
        }
      });
    }

    it('(i) a DID rule records the call from the flow’s answer, once', async () => {
      await scenario({
        rule: 'did',
        check: async ({ tenantId, didId }) => {
          const ready = await waitForReady(tenantId, didId);
          // Exactly one: the hand-off to 401 saw the call was already recorded.
          expect(ready).toHaveLength(1);
          expect(ready[0]).toMatchObject({ didId, direction: 'inbound', extensionId: null });
          expect(ready[0]!.sizeBytes ?? 0).toBeGreaterThan(44);
          expect(await spoolListing()).not.toContain(`${ready[0]!.id}.wav`);
        },
      });
    }, 240_000);

    it('(ii) only an extension rule for 401: recorded when the flow hands the call to 401', async () => {
      await scenario({
        rule: 'extension',
        check: async ({ tenantId, didId, id401 }) => {
          const ready = await waitForReady(tenantId, didId);
          expect(ready).toHaveLength(1);
          expect(ready[0]).toMatchObject({ didId, extensionId: id401, direction: 'inbound' });
          expect(ready[0]!.sizeBytes ?? 0).toBeGreaterThan(44);
          expect(await spoolListing()).not.toContain(`${ready[0]!.id}.wav`);
        },
      });
    }, 240_000);

    it('(iii) no rule: the call through the flow is not recorded', async () => {
      await scenario({
        rule: null,
        check: async ({ tenantId, didId }) => {
          // Long enough for a recording, had there been one, to have been registered.
          await new Promise((resolve) => setTimeout(resolve, 3000));
          expect(await recordingsForDid(tenantId, didId)).toEqual([]);
        },
      });
    }, 240_000);
  },
);
