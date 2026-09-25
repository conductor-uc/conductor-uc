import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  clearRegistration,
  dockerCurlJson,
  runForeground,
  seedFixtures,
  sipInfraOrSkipReason,
  startUas,
  stopContainer,
  tenantAdminHeaders,
  withSingleFsNode,
  type SeedResult,
} from '../src/run-scenario.js';

const skipReason = await sipInfraOrSkipReason();

const PBX_CONFIG_SERVICE_URL = 'http://pbx-config-service:8080';
const RECORDING_SERVICE_URL = 'http://recording-service:8080';
const IDENTITY_SERVICE_URL = 'http://identity-service:8080';
const CALLER_CONTAINER = 'sip-test-ondemand-caller';
const UAS_401 = 'sip-test-ondemand-uas-401';

interface Recording {
  readonly id: string;
  readonly extensionId: string | null;
  readonly peerExtensionId: string | null;
  readonly direction: string;
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
}

/**
 * S5-13 (G-111), live: the in-call recording feature codes, on an internal call from 402 to 401
 * (both parties are the tenant's own, so both legs listen for the codes). The caller presses the
 * codes by RFC 4733 DTMF (`uac_call_star1_twice.xml`, `uac_call_star2_twice.xml`).
 *
 * - With a rule for 401 that does not record but allows on demand: `*1` starts an on-demand
 *   recording, `*1` stops it; the recording is uploaded like any other, is marked on demand and
 *   stopped, and both actions are in the tenant's audit trail.
 * - With a rule for 401 that records and allows on demand: `*2` pauses and `*2` resumes; the
 *   recording is uploaded with one closed pause, and both actions are audited.
 *
 * Needs the FreeSWITCH image rebuilt with this branch's `recording_control.lua`. Unverified live:
 * `bind_meta_app` running the script on the pressing leg, the beep during the bridge, `uuid_record
 * mask` on a recording started by `execute_on_answer=record_session`, and a second `*` press in
 * one call (see the scenarios' own comments on the pcaps).
 */
describe.skipIf(skipReason !== undefined)('S5-13 on-demand recording and pause (live SIPp)', () => {
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

  /** Recordings of 401 that started after `since`, once all of them are uploaded. */
  async function readyRecordingsSince(
    tenantId: string,
    id401: string,
    since: Date,
  ): Promise<Recording[]> {
    const deadline = Date.now() + 120_000;
    let last: Recording[] = [];
    while (Date.now() < deadline) {
      const { rows } = await ok<{ rows: Recording[] }>(
        'GET',
        `${RECORDING_SERVICE_URL}/v1/tenants/${tenantId}/recordings?extensionId=${id401}&from=${since.toISOString()}`,
        undefined,
        200,
      );
      last = rows;
      if (rows.length > 0 && rows.every((r) => r.status === 'ready')) return rows;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw new Error(`no ready recording; last seen: ${JSON.stringify(last)}`);
  }

  /** Audit events for `resource`, once all `actions` are there (they arrive through the outbox). */
  async function auditFor(tenantId: string, resource: string, actions: string[]) {
    const deadline = Date.now() + 30_000;
    let found: AuditEvent[] = [];
    while (Date.now() < deadline) {
      const response = await call(
        'GET',
        `${IDENTITY_SERVICE_URL}/v1/orgs/${tenantId}/audit-events?limit=200`,
      );
      expect(response.status, JSON.stringify(response.json)).toBe(200);
      found = (response.json as { rows: AuditEvent[] }).rows.filter(
        (event) => event.resource === resource,
      );
      if (actions.every((action) => found.some((event) => event.action === action))) return found;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(
      `audit trail for ${resource} is missing some of ${actions.join(', ')}: ${JSON.stringify(found)}`,
    );
  }

  /** 402 calls 401 (answering) under `rule` for 401, pressing codes as `scenario` does. */
  async function scenario(options: {
    rule: Record<string, unknown>;
    scenario: string;
    check: (ids: { tenantId: string; id401: string; since: Date }) => Promise<void>;
  }): Promise<void> {
    await withSingleFsNode(async () => {
      const tenantId = seed.tenantVoicemail.id;
      const fqdn = seed.tenantVoicemail.fqdn;
      const id401 = await extensionId(tenantId, '401');
      await clearRegistration(`401@${fqdn}`);
      await clearRegistration(`402@${fqdn}`);
      let policyId: string | undefined;
      try {
        const policy = await ok(
          'POST',
          `${RECORDING_SERVICE_URL}/v1/tenants/${tenantId}/recording-policies`,
          { scopeType: 'extension', scopeId: id401, direction: 'any', ...options.rule },
          201,
        );
        policyId = policy.id;

        const uas = startUas({
          au: '401',
          ap: password('401'),
          authUri: fqdn,
          csvLine: `401;${fqdn}`,
          containerName: UAS_401,
        });
        await uas.ready();

        const since = new Date(Date.now() - 1000);
        const result = await runForeground({
          scenario: options.scenario,
          csvLine: `402;${fqdn};401`,
          au: '402',
          ap: password('402'),
          authUri: fqdn,
          containerName: CALLER_CONTAINER,
        });
        expect(result.successfulCalls, result.stdout).toBe(1);
        const answered = await uas.result();
        expect(answered.successfulCalls, answered.stdout).toBe(1);

        await options.check({ tenantId, id401, since });
      } finally {
        if (policyId !== undefined) {
          await call(
            'DELETE',
            `${RECORDING_SERVICE_URL}/v1/tenants/${tenantId}/recording-policies/${policyId}`,
          );
        }
      }
    });
  }

  it('*1 starts an on-demand recording where the rule allows it, *1 stops it; both audited', async () => {
    await scenario({
      rule: { action: 'no_record', allowOnDemand: true },
      scenario: 'uac_call_star1_twice.xml',
      check: async ({ tenantId, id401, since }) => {
        const ready = await readyRecordingsSince(tenantId, id401, since);
        expect(ready).toHaveLength(1);
        const recording = ready[0]!;
        expect(recording).toMatchObject({ onDemand: true, direction: 'internal' });
        expect(recording.stoppedAt).not.toBeNull();
        expect(recording.sizeBytes ?? 0).toBeGreaterThan(44);

        const events = await auditFor(tenantId, `recording:${recording.id}`, [
          'recording.on_demand.started',
          'recording.on_demand.stopped',
        ]);
        expect(events.every((event) => event.actorType === 'node')).toBe(true);
      },
    });
  }, 240_000);

  it('*2 pauses a rule recording where the rule allows it, *2 resumes it; both audited', async () => {
    await scenario({
      rule: { action: 'record', allowOnDemand: true },
      scenario: 'uac_call_star2_twice.xml',
      check: async ({ tenantId, id401, since }) => {
        const ready = await readyRecordingsSince(tenantId, id401, since);
        expect(ready).toHaveLength(1);
        const recording = ready[0]!;
        expect(recording.onDemand).toBe(false);
        expect(recording.pauses).toHaveLength(1);
        expect(recording.pauses[0]!.to).not.toBeNull();
        expect(recording.sizeBytes ?? 0).toBeGreaterThan(44);

        await auditFor(tenantId, `recording:${recording.id}`, [
          'recording.paused',
          'recording.resumed',
        ]);
      },
    });
  }, 240_000);

  it('*1 does nothing where no rule allows it', async () => {
    await scenario({
      rule: { action: 'no_record', allowOnDemand: false },
      scenario: 'uac_call_star1_twice.xml',
      check: async ({ tenantId, id401, since }) => {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const { rows } = await ok<{ rows: Recording[] }>(
          'GET',
          `${RECORDING_SERVICE_URL}/v1/tenants/${tenantId}/recordings?extensionId=${id401}&from=${since.toISOString()}`,
          undefined,
          200,
        );
        expect(rows).toEqual([]);
      },
    });
  }, 240_000);
});
