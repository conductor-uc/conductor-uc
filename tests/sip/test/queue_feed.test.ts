import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createSignInAdmin,
  dockerCurlJson,
  fsCli,
  internalServiceHeaders,
  seedFixtures,
  signInThroughGateway,
  sipInfraOrSkipReason,
  startDelayedCaller,
  stopContainer,
  tenantAdminCurlJson,
  tenantAdminHeaders,
  waitForProjected,
  waitForTrunkRemoved,
  withSingleFsNode,
  type SeedResult,
} from '../src/run-scenario.js';

const skipReason = await sipInfraOrSkipReason();

const GATEWAY_URL = 'http://api-gateway:8080';
const PBX_CONFIG_SERVICE_URL = 'http://pbx-config-service:8080';
const TRUNK_SERVICE_URL = 'http://trunk-service:8080';
const IDENTITY_SERVICE_URL = 'http://identity-service:8080';
const CALL_CONTROL_URL = 'http://call-control:8080';
const CARRIER_TARGET_DOMAIN = 'opensips';
const CALLER_CONTAINER = 'sip-test-queue-feed-caller';

interface LiveQueue {
  readonly queueId: string;
  readonly waiting: number;
  readonly longestWaitingSince: string | null;
  readonly agents: { readonly extension: string; readonly status: string }[];
}

/**
 * S9-13, live: what `mod_callcenter` really answers to `callcenter_config ... list`, read by
 * call-control for the `queues` topic, and an agent signed in and put on a break from the console
 * over HTTP, on the node, instead of with `*45`.
 *
 * A queue in the queue tenant with extension 301 as its agent, loaded on the node by a priming
 * carrier call (`queue.test.ts` explains why a queue is only ever loaded by a call), and the tier
 * added by hand (G-47). A tenant administrator (who holds `call.control`) signs 301 in through
 * api-gateway: the node's agent is Available, and the live queues show 301 available. On a break,
 * then a carrier call into the queue: it waits, and the live queues count it, with no number.
 */
describe.skipIf(skipReason !== undefined)('S9-13 live queues and agent status (live SIPp)', () => {
  let seed: SeedResult;
  let tenantId: string;
  let token: string;
  let userId: string;

  beforeAll(async () => {
    seed = await seedFixtures();
    tenantId = seed.tenantQueue.id;
    const admin = await createSignInAdmin(tenantId, seed.resellerId);
    userId = admin.userId;
    token = await signInThroughGateway(GATEWAY_URL, tenantId, admin.email, admin.password);
  }, 120_000);

  afterEach(async () => {
    await stopContainer(CALLER_CONTAINER);
  });

  async function ok<T = { id: string }>(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    body: unknown,
    status: number,
  ): Promise<T> {
    const response = await tenantAdminCurlJson(seed.resellerId, method, url, body);
    expect(response.status, `${method} ${url}: ${JSON.stringify(response.json)}`).toBe(status);
    return response.json as T;
  }

  async function liveQueue(queueId: string): Promise<LiveQueue | undefined> {
    const response = await dockerCurlJson(
      'GET',
      `${CALL_CONTROL_URL}/internal/v1/tenants/${tenantId}/queues`,
      undefined,
      internalServiceHeaders(),
    );
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    return (response.json as { queues: LiveQueue[] }).queues.find((q) => q.queueId === queueId);
  }

  async function until(
    what: string,
    queueId: string,
    match: (queue: LiveQueue) => boolean,
  ): Promise<LiveQueue> {
    const deadline = Date.now() + 30_000;
    let last: LiveQueue | undefined;
    while (Date.now() < deadline) {
      last = await liveQueue(queueId);
      if (last !== undefined && match(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`${what} never happened: ${JSON.stringify(last)}`);
  }

  function setStatus(status: 'available' | 'on_break' | 'logged_out') {
    return dockerCurlJson(
      'PUT',
      `${GATEWAY_URL}/v1/tenants/${tenantId}/live-agents/301/status`,
      { status },
      { authorization: `Bearer ${token}` },
    );
  }

  async function trunkAndDid(ip: string, e164: string, queueId: string) {
    const trunk = await ok(
      'POST',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks`,
      {
        name: 'S9-13 queue trunk',
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

  async function removeTrunkAndDid(ids: { trunkId: string; didId: string }) {
    await tenantAdminCurlJson(
      seed.resellerId,
      'DELETE',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/dids/${ids.didId}`,
    );
    await tenantAdminCurlJson(
      seed.resellerId,
      'DELETE',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks/${ids.trunkId}`,
    );
    await waitForTrunkRemoved(ids.trunkId);
  }

  it('signs 301 in and on a break from the console, and the live queues follow, a waiting caller included', async () => {
    await withSingleFsNode(async () => {
      const { rows } = await ok<{ rows: { id: string; number: string }[] }>(
        'GET',
        `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/extensions`,
        undefined,
        200,
      );
      const id301 = rows.find((row) => row.number === '301')!.id;
      const queue = await ok(
        'POST',
        `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/queues`,
        { label: 'S9-13 queue', strategy: 'ring-all', maxWaitSeconds: 60, announcePosition: false },
        201,
      );
      let agentId: string | undefined;
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
        await waitForProjected('queues', 'id', queue.id);
        await waitForProjected('queue_tiers', 'agent_id', agentId);

        // Load the queue on the node with a throwaway call (`queue.test.ts`).
        const e164 = `+1555994${String(Math.floor(1000 + Math.random() * 9000))}`;
        const priming = await startDelayedCaller({
          scenario: 'trunk_invite.xml',
          csvLine: `carrier;${CARRIER_TARGET_DOMAIN};${e164}`,
          containerName: CALLER_CONTAINER,
          startOnSignal: true,
        });
        trunk = await trunkAndDid(priming.ip, e164, queue.id);
        await priming.startWhenRouted(trunk);
        await priming.result();
        await removeTrunkAndDid(trunk);
        trunk = undefined;
        await stopContainer(CALLER_CONTAINER);

        const fqdn = seed.tenantQueue.fqdn;
        const signedIn = await setStatus('available');
        expect(signedIn.status, JSON.stringify(signedIn.json)).toBe(200);
        expect(signedIn.json).toMatchObject({ extension: '301', status: 'available' });
        expect(await fsCli(`callcenter_config agent get status 301@${fqdn}`)).toContain(
          'Available',
        );
        // G-47: a lazily loaded queue has no tiers; added by hand (idempotent).
        await fsCli(`callcenter_config tier add ${queue.id}@${fqdn} 301@${fqdn} 1 1`);

        await until('301 shown available', queue.id, (q) =>
          q.agents.some((a) => a.extension === '301' && a.status === 'available'),
        );

        const onBreak = await setStatus('on_break');
        expect(onBreak.status, JSON.stringify(onBreak.json)).toBe(200);
        await until('301 shown on a break', queue.id, (q) =>
          q.agents.some((a) => a.extension === '301' && a.status === 'on_break'),
        );

        // With nobody available, a caller waits, and is counted.
        const caller = await startDelayedCaller({
          scenario: 'trunk_invite_hold_long.xml',
          csvLine: `carrier;${CARRIER_TARGET_DOMAIN};${e164}`,
          containerName: CALLER_CONTAINER,
          startOnSignal: true,
        });
        trunk = await trunkAndDid(caller.ip, e164, queue.id);
        await caller.startWhenRouted(trunk);
        const waiting = await until('a caller waiting', queue.id, (q) => q.waiting >= 1);
        expect(waiting.longestWaitingSince).not.toBeNull();
        expect(JSON.stringify(waiting)).not.toContain('carrier');

        // Both changes are in the tenant's audit trail, as the administrator's.
        await expect
          .poll(
            async () => {
              const audits = await dockerCurlJson(
                'GET',
                `${IDENTITY_SERVICE_URL}/v1/orgs/${tenantId}/audit-events?limit=200`,
                undefined,
                await tenantAdminHeaders(tenantId, seed.resellerId),
              );
              return (audits.json as { rows: { action: string; actorId: string }[] }).rows.filter(
                (row) => row.action === 'queue.agent.status_changed' && row.actorId === userId,
              ).length;
            },
            { timeout: 30_000, interval: 1_000 },
          )
          .toBeGreaterThanOrEqual(2);
      } finally {
        await setStatus('logged_out');
        if (trunk !== undefined) await removeTrunkAndDid(trunk);
        if (agentId !== undefined) {
          await tenantAdminCurlJson(
            seed.resellerId,
            'DELETE',
            `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/agents/${agentId}`,
          );
        }
        await tenantAdminCurlJson(
          seed.resellerId,
          'DELETE',
          `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/queues/${queue.id}`,
        );
      }
    });
  }, 300_000);
});
