import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  clearRegistration,
  dockerCurlJson,
  fsCli,
  seedFixtures,
  sipInfraOrSkipReason,
  startAgentUas,
  startDelayedCaller,
  stopContainer,
  tenantAdminHeaders,
  withSingleFsNode,
  type SeedResult,
  type UasHandle,
} from '../src/run-scenario.js';

const skipReason = await sipInfraOrSkipReason();

const PBX_CONFIG_SERVICE_URL = 'http://pbx-config-service:8080';
const TRUNK_SERVICE_URL = 'http://trunk-service:8080';
const RECORDING_SERVICE_URL = 'http://recording-service:8080';
const CARRIER_TARGET_DOMAIN = 'opensips';
const AGENT_CONTAINER = 'sip-test-recagent-agent';
const CALLER_CONTAINER = 'sip-test-recagent-caller';
const AGENT_LOGIN_FEATURE_CODE = '*45';

interface Recording {
  readonly id: string;
  readonly extensionId: string | null;
  readonly queueId: string | null;
  readonly didId: string | null;
  readonly direction: string;
  readonly status: string;
  readonly sizeBytes: number | null;
}

/**
 * S5-14 (G-111), live: agent-scoped recording rules for queue calls.
 *
 * A carrier call to a DID for a queue with one agent, 301, logged in (`*45`). The decision for an
 * agent rule is made when the agent answers: the queue call carries `cc_export_vars` and
 * `execute_on_answer_cuc_agent`, so `agent_recording.lua` runs on the agent's leg as 301 answers,
 * asks telephony-config's `/fs/recording/:tenantId/agent-answer`, and records the agent's leg.
 *
 * - (i) an agent rule for 301: one recording, registered to 301's extension and the queue.
 * - (ii) a queue rule that records, and the same agent rule: exactly one recording, the queue's
 *   from setup (no extension), because the agent's leg sees the caller is already recorded.
 * - (iii) no rule: nothing.
 *
 * DEPENDS ON QUEUE DISTRIBUTION, WHICH HAS NEVER BEEN SEEN WORKING LIVE (G-47,
 * `queue.test.ts`'s own comment). This branch routes the agent's contact through OpenSIPs
 * (`agentContact`: phones register there, and `user/<agent>` had no dial-string to use), and this
 * test adds the queue's tier by hand (`callcenter_config tier add`), the other gap G-47 names
 * and leaves to the owner. If the agent's `answer_call.xml` never gets the INVITE, the failure is
 * that, not the recording. Needs the FreeSWITCH image rebuilt with this branch's scripts.
 */
describe.skipIf(skipReason !== undefined)('S5-14 agent-scoped recording (live SIPp)', () => {
  let seed: SeedResult;

  beforeAll(async () => {
    seed = await seedFixtures();
  }, 60_000);

  afterEach(async () => {
    await Promise.all([AGENT_CONTAINER, CALLER_CONTAINER].map((name) => stopContainer(name)));
  });

  async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) {
    return dockerCurlJson(
      method,
      url,
      body,
      await tenantAdminHeaders(seed.tenantQueue.id, seed.resellerId),
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

  async function trunkAndDid(
    tenantId: string,
    ip: string,
    e164: string,
    queueId: string,
  ): Promise<{ trunkId: string; didId: string }> {
    const trunk = await ok(
      'POST',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks`,
      {
        name: 'S5-14 queue trunk',
        authMode: 'ip',
        host: ip,
        port: 5060,
        transport: 'udp',
        codecs: ['PCMU'],
      },
      201,
    );
    await ok(
      'POST',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks/${trunk.id}/ips`,
      { cidr: `${ip}/32` },
      201,
    );
    const did = await ok(
      'POST',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/dids`,
      { e164, trunkId: trunk.id, destinationType: 'queue', destinationId: queueId },
      201,
    );
    return { trunkId: trunk.id, didId: did.id };
  }

  async function removeTrunkAndDid(
    tenantId: string,
    ids: { trunkId: string; didId: string },
  ): Promise<void> {
    await call('DELETE', `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/dids/${ids.didId}`);
    await call('DELETE', `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks/${ids.trunkId}`);
    // As `queue.test.ts`: let a freed IP settle before the next container can reuse it.
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  async function recordingsForQueue(tenantId: string, queueId: string): Promise<Recording[]> {
    const { rows } = await ok<{ rows: Recording[] }>(
      'GET',
      `${RECORDING_SERVICE_URL}/v1/tenants/${tenantId}/recordings?queueId=${queueId}`,
      undefined,
      200,
    );
    return rows;
  }

  async function waitForReady(tenantId: string, queueId: string): Promise<Recording[]> {
    const deadline = Date.now() + 120_000;
    let last: Recording[] = [];
    while (Date.now() < deadline) {
      last = await recordingsForQueue(tenantId, queueId);
      if (last.length > 0 && last.every((r) => r.status === 'ready')) return last;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw new Error(`no ready recording for the queue; last seen: ${JSON.stringify(last)}`);
  }

  /**
   * A fresh queue with 301 as its agent, logged in and tiered, then one carrier call into it
   * under `rules`, answered by 301. Cleans up everything it made.
   */
  async function queueCall(options: {
    rules: (ids: { id301: string; queueId: string }) => Record<string, unknown>[];
    check: (ids: { tenantId: string; id301: string; queueId: string }) => Promise<void>;
  }): Promise<void> {
    await withSingleFsNode(async () => {
      const tenantId = seed.tenantQueue.id;
      const fqdn = seed.tenantQueue.fqdn;
      const ext301 = seed.extensions[`${fqdn}/301`];
      if (ext301 === undefined) throw new Error('tenantQueue/301 was not seeded');
      await clearRegistration(`301@${fqdn}`);
      const id301 = await extensionId(tenantId, '301');

      const queue = await ok(
        'POST',
        `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/queues`,
        { label: 'S5-14 queue', strategy: 'ring-all', maxWaitSeconds: 60, announcePosition: false },
        201,
      );
      const policyIds: string[] = [];
      let agentId: string | undefined;
      let agent: UasHandle | undefined;
      let trunk: { trunkId: string; didId: string } | undefined;
      try {
        agentId = (
          await ok(
            'POST',
            `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/agents`,
            { extensionId: id301 },
            201,
          )
        ).id;
        await ok(
          'POST',
          `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/queues/${queue.id}/tiers`,
          { agentId },
          201,
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Prime mod_callcenter's load of the new queue with a throwaway call, then remove its
        // trunk before the agent registers: `queue.test.ts` explains both steps.
        const e164 = `+1555992${String(Math.floor(1000 + Math.random() * 9000))}`;
        const priming = await startDelayedCaller({
          scenario: 'trunk_invite.xml',
          csvLine: `carrier;${CARRIER_TARGET_DOMAIN};${e164}`,
          containerName: CALLER_CONTAINER,
        });
        trunk = await trunkAndDid(tenantId, priming.ip, e164, queue.id);
        await priming.result();
        await removeTrunkAndDid(tenantId, trunk);
        trunk = undefined;
        await stopContainer(CALLER_CONTAINER);

        agent = startAgentUas({
          au: '301',
          ap: ext301.password,
          authUri: fqdn,
          agentNumber: '301',
          featureCode: AGENT_LOGIN_FEATURE_CODE,
          containerName: AGENT_CONTAINER,
        });
        await agent.ready();

        // G-47's open tier gap, worked around here: mod_callcenter's lazy queue load never loads
        // tiers, so the agent is added to the queue by hand (idempotent).
        const queueName = `${queue.id}@${fqdn}`;
        const agentName = `301@${fqdn}`;
        await fsCli(`callcenter_config tier add ${queueName} ${agentName} 1 1`);
        expect(await fsCli('callcenter_config agent list')).toContain(agentName);
        // The contact this branch sets on login: through OpenSIPs, not `user/`.
        expect(await fsCli('callcenter_config agent list')).toContain('sofia/internal/301@');

        for (const rule of options.rules({ id301, queueId: queue.id })) {
          const created = await ok(
            'POST',
            `${RECORDING_SERVICE_URL}/v1/tenants/${tenantId}/recording-policies`,
            rule,
            201,
          );
          policyIds.push(created.id);
        }

        const caller = await startDelayedCaller({
          scenario: 'trunk_invite_hold_long.xml',
          csvLine: `carrier;${CARRIER_TARGET_DOMAIN};${e164}`,
          containerName: CALLER_CONTAINER,
        });
        trunk = await trunkAndDid(tenantId, caller.ip, e164, queue.id);

        const callerResult = await caller.result();
        expect(callerResult.successfulCalls, callerResult.stdout).toBe(1);
        const answered = await agent.result();
        expect(
          answered.successfulCalls,
          `the agent was never offered the call (G-47)\n${answered.stdout}`,
        ).toBe(1);

        await options.check({ tenantId, id301, queueId: queue.id });
      } finally {
        await agent?.stop();
        if (trunk !== undefined) await removeTrunkAndDid(tenantId, trunk);
        for (const id of policyIds) {
          await call(
            'DELETE',
            `${RECORDING_SERVICE_URL}/v1/tenants/${tenantId}/recording-policies/${id}`,
          );
        }
        if (agentId !== undefined) {
          await call(
            'DELETE',
            `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/agents/${agentId}`,
          );
        }
        await call('DELETE', `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/queues/${queue.id}`);
      }
    });
  }

  it('(i) an agent rule records the queue call from the moment 301 answers', async () => {
    await queueCall({
      rules: ({ id301 }) => [{ scopeType: 'agent', scopeId: id301, action: 'record' }],
      check: async ({ tenantId, id301, queueId }) => {
        const ready = await waitForReady(tenantId, queueId);
        expect(ready).toHaveLength(1);
        expect(ready[0]).toMatchObject({ extensionId: id301, queueId, direction: 'inbound' });
        expect(ready[0]!.sizeBytes ?? 0).toBeGreaterThan(44);
      },
    });
  }, 300_000);

  it('(ii) a queue rule already recording the call: the agent rule adds no second recording', async () => {
    await queueCall({
      rules: ({ id301, queueId }) => [
        { scopeType: 'queue', scopeId: queueId, action: 'record' },
        { scopeType: 'agent', scopeId: id301, action: 'record' },
      ],
      check: async ({ tenantId, queueId }) => {
        const ready = await waitForReady(tenantId, queueId);
        // Give a second recording, had there been one, time to appear too.
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const all = await recordingsForQueue(tenantId, queueId);
        expect(all).toHaveLength(1);
        // The queue's recording from setup, on the caller's side: no agent extension on it.
        expect(ready[0]).toMatchObject({ queueId, extensionId: null });
      },
    });
  }, 300_000);

  it('(iii) no rule: the queue call is not recorded', async () => {
    await queueCall({
      rules: () => [],
      check: async ({ tenantId, queueId }) => {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        expect(await recordingsForQueue(tenantId, queueId)).toEqual([]);
      },
    });
  }, 300_000);
});
