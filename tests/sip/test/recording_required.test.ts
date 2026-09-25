import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  clearRegistration,
  dockerCurlJson,
  recordingServiceContainer,
  seedFixtures,
  sipInfraOrSkipReason,
  startDelayedCaller,
  startUas,
  stopContainer,
  telephonyConfigSql,
  tenantAdminHeaders,
  uasReceivedCall,
  waitForHttpReady,
  withContainerStopped,
  withSingleFsNode,
  type SeedResult,
} from '../src/run-scenario.js';

const skipReason = await sipInfraOrSkipReason();

const PBX_CONFIG_SERVICE_URL = 'http://pbx-config-service:8080';
const TRUNK_SERVICE_URL = 'http://trunk-service:8080';
const RECORDING_SERVICE_URL = 'http://recording-service:8080';
const CARRIER_TARGET_DOMAIN = 'opensips';
const CALLER_CONTAINER = 'sip-test-recreq-caller';
const UAS_401 = 'sip-test-recreq-uas-401';

/**
 * S5-12 (G-111), live: a tenant's "recording required" (fail-closed) option.
 *
 * The flag is kept in telephony-config's own copy (`recording_settings`, projected from
 * `recording.settings.updated`), so it holds while recording-service is down. This test **stops
 * the recording-service container** (`SIP_TEST_RECORDING_SERVICE_CONTAINER`, default
 * `conductor-uc-recording-service-1`) to make every recording decision unavailable, and always
 * starts it again (and waits for `/readyz`) before moving on, even when an assertion fails.
 *
 * - With the flag on and recording-service up, a call no rule records is placed as usual: a
 *   decision of "no recording needed" is never refused.
 * - With the flag on and recording-service stopped, a carrier call to a DID for 401 (which has a
 *   record rule) hears a neutral tone as early media and is refused with SIP 500 (FreeSWITCH's 503, which
 *   OpenSIPs relays as 500, RFC 3261 §16.7); 401 never rings.
 * - With the flag off and recording-service stopped, the same call goes ahead unrecorded (the
 *   default, fail open).
 */
describe.skipIf(skipReason !== undefined)('S5-12 recording required (live SIPp)', () => {
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

  /** Sets the flag through the API, then waits until telephony-config's own copy has it. */
  async function requireRecording(tenantId: string, on: boolean): Promise<void> {
    await ok(
      'PUT',
      `${RECORDING_SERVICE_URL}/v1/tenants/${tenantId}/recording-settings`,
      { failClosed: on },
      200,
    );
    const want = on ? '1' : '0';
    const deadline = Date.now() + 30_000;
    for (;;) {
      const got = await telephonyConfigSql(
        `SELECT fail_closed FROM recording_settings WHERE tenant_id = '${tenantId}'`,
      );
      if (got === want || (!on && got === '')) return;
      if (Date.now() > deadline) {
        throw new Error(`telephony-config never saw failClosed=${String(on)} (has '${got}')`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /**
   * One carrier call to a fresh DID for 401 (registered and answering). `during` wraps the call
   * itself, so the test can stop recording-service around exactly that. Cleans up afterwards.
   */
  async function carrierCall(options: {
    scenario: string;
    during: <T>(fn: () => Promise<T>) => Promise<T>;
    check: (ids: {
      tenantId: string;
      didId: string;
      result: { successfulCalls: number; stdout: string };
    }) => Promise<void>;
  }): Promise<void> {
    const tenantId = seed.tenantVoicemail.id;
    const id401 = await extensionId(tenantId, '401');
    await clearRegistration(`401@${seed.tenantVoicemail.fqdn}`);
    let trunkId: string | undefined;
    let didId: string | undefined;
    try {
      const uas = startUas({
        au: '401',
        ap: password('401'),
        authUri: seed.tenantVoicemail.fqdn,
        csvLine: `401;${seed.tenantVoicemail.fqdn}`,
        containerName: UAS_401,
      });
      await uas.ready();

      const e164 = `+1555993${String(Math.floor(1000 + Math.random() * 9000))}`;
      const trunkAndDid = async (ip: string) => {
        const trunk = await ok(
          'POST',
          `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks`,
          {
            name: 'S5-12 trunk',
            authMode: 'ip',
            host: ip,
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
          { cidr: `${ip}/32` },
          201,
        );
        const did = await ok(
          'POST',
          `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/dids`,
          { e164, trunkId, destinationType: 'extension', destinationId: id401 },
          201,
        );
        didId = did.id;
      };

      // Provisioning the trunk and DID does not involve recording-service, so the whole call,
      // provisioning included, runs inside `during`: recording-service is already stopped before
      // the caller starts its 6 s pause, whatever `docker stop` takes. The checks run after
      // `during` returns, when it is running again.
      const result = await options.during(async () => {
        const caller = await startDelayedCaller({
          scenario: options.scenario,
          csvLine: `carrier;${CARRIER_TARGET_DOMAIN};${e164}`,
          containerName: CALLER_CONTAINER,
        });
        await trunkAndDid(caller.ip);
        return caller.result();
      });
      await options.check({ tenantId, didId: didId!, result });
      await uas.stop();
    } finally {
      if (didId !== undefined) {
        await call('DELETE', `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/dids/${didId}`);
      }
      if (trunkId !== undefined) {
        await call('DELETE', `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks/${trunkId}`);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  }

  const asIs = <T>(fn: () => Promise<T>) => fn();
  const withRecordingServiceDown = <T>(fn: () => Promise<T>) =>
    withContainerStopped(recordingServiceContainer(), `${RECORDING_SERVICE_URL}/readyz`, fn);

  async function recordingsForDid(tenantId: string, didId: string): Promise<unknown[]> {
    const { rows } = await ok<{ rows: unknown[] }>(
      'GET',
      `${RECORDING_SERVICE_URL}/v1/tenants/${tenantId}/recordings?didId=${didId}`,
      undefined,
      200,
    );
    return rows;
  }

  it('refuses only when required, only when unavailable; fails open otherwise', async () => {
    const tenantId = seed.tenantVoicemail.id;
    const id401 = await extensionId(tenantId, '401');
    let policyId: string | undefined;
    await withSingleFsNode(async () => {
      try {
        await requireRecording(tenantId, true);

        // 1. Required, service up, no rule for 401: "no recording needed" is never refused.
        await carrierCall({
          scenario: 'trunk_invite_hold.xml',
          during: asIs,
          check: async ({ result }) => {
            expect(result.successfulCalls, result.stdout).toBe(1);
            expect(await uasReceivedCall(UAS_401)).toBe(true);
          },
        });

        const policy = await ok(
          'POST',
          `${RECORDING_SERVICE_URL}/v1/tenants/${tenantId}/recording-policies`,
          { scopeType: 'extension', scopeId: id401, direction: 'any', action: 'record' },
          201,
        );
        policyId = policy.id;

        // 2. Required, service stopped: refused with 500 after the tone; 401 never rings.
        await carrierCall({
          scenario: 'trunk_invite_expect_500.xml',
          during: withRecordingServiceDown,
          check: async ({ tenantId: t, didId, result }) => {
            expect(result.successfulCalls, result.stdout).toBe(1);
            expect(await uasReceivedCall(UAS_401)).toBe(false);
            expect(await recordingsForDid(t, didId)).toEqual([]);
          },
        });

        // 3. Not required, service stopped: the call goes ahead, unrecorded (fail open).
        await requireRecording(tenantId, false);
        await carrierCall({
          scenario: 'trunk_invite_hold.xml',
          during: withRecordingServiceDown,
          check: async ({ tenantId: t, didId, result }) => {
            expect(result.successfulCalls, result.stdout).toBe(1);
            expect(await uasReceivedCall(UAS_401)).toBe(true);
            expect(await recordingsForDid(t, didId)).toEqual([]);
          },
        });
      } finally {
        // Whatever happened above, recording-service is running again (withContainerStopped
        // restarts it); make sure of it, then put the tenant back to the default.
        await waitForHttpReady(`${RECORDING_SERVICE_URL}/readyz`, 90_000);
        if (policyId !== undefined) {
          await call(
            'DELETE',
            `${RECORDING_SERVICE_URL}/v1/tenants/${tenantId}/recording-policies/${policyId}`,
          );
        }
        await requireRecording(tenantId, false);
      }
    });
  }, 600_000);
});
