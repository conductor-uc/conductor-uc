import { randomUUID } from 'node:crypto';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  clearRegistration,
  composeProject,
  dispatcherStates,
  dockerCurlJson,
  fsCliOn,
  internalServiceHeaders,
  opensipsMi,
  opensipsSql,
  runForeground,
  seedFixtures,
  sipInfraOrSkipReason,
  sipTestEnv,
  startUas,
  stopContainer,
  type SeedResult,
} from '../src/run-scenario.js';

const skipReason = await sipInfraOrSkipReason();

const CALL_CONTROL_URL = 'http://call-control:8080';
const DRAINED_NODE = 'freeswitch-2';
const DRAINED_URI = 'sip:freeswitch-2:5060';
const CALLS = 4;
const LEGS_PER_CALL = 2;

interface NodeView {
  readonly nodeId: string;
  readonly status: string;
  readonly draining: boolean;
  readonly calls: number;
  readonly leases: number;
}

/**
 * Each FS node's "N session(s) since startup" (`status`), keyed by node id. A call from one phone
 * to another is two sessions on the node that took it: the caller's leg and the leg it rings.
 */
async function sessionsSinceStartup(): Promise<Record<string, number>> {
  const env = sipTestEnv();
  const counts: Record<string, number> = {};
  for (const container of env.freeswitchContainers) {
    const status = await fsCliOn(container, 'status');
    const match = /(\d+) session\(s\) since startup/.exec(status);
    if (match === null) throw new Error(`no session count in ${container}'s status:\n${status}`);
    // `{project}-freeswitch-2-1` is node `freeswitch-2` (FS_NODES in docker-compose.yml).
    const nodeId = container.slice(`${composeProject()}-`.length).replace(/-\d+$/, '');
    counts[nodeId] = Number(match[1]);
  }
  return counts;
}

async function waitForState(uri: string, state: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const destinations = await dispatcherStates();
    if (destinations.find((destination) => destination.uri === uri)?.state === state) return;
    if (Date.now() > deadline) {
      throw new Error(`${uri} never became ${state}: ${JSON.stringify(destinations)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function nodeAction(action: 'drain' | 'undrain'): Promise<{
  node: NodeView;
  leasesHandedOver: number;
}> {
  const response = await dockerCurlJson(
    'POST',
    `${CALL_CONTROL_URL}/internal/v1/nodes/${DRAINED_NODE}/${action}`,
    undefined,
    internalServiceHeaders(),
  );
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  return response.json as { node: NodeView; leasesHandedOver: number };
}

/**
 * S4-02 (G-123): the FS pool at OpenSIPs. Weights steer new calls, a drained node gets none and
 * gives up its leases, and an undrained one is back in rotation. Which node took a call is read
 * from each node's own session counter.
 */
describe.skipIf(skipReason !== undefined)('S4-02 dispatcher weights and draining', () => {
  let seed: SeedResult;

  beforeAll(async () => {
    seed = await seedFixtures();
  }, 60_000);

  afterEach(async () => {
    await nodeAction('undrain');
    await opensipsSql("UPDATE dispatcher SET weight = '1' WHERE setid = 1");
    await opensipsMi('ds_reload');
  });

  /** 101 calls 102 `CALLS` times; each call's two legs are on the node OpenSIPs chose. */
  async function placeCalls(label: string): Promise<void> {
    const fqdn = seed.tenantA.fqdn;
    const ext101 = seed.extensions[`${fqdn}/101`];
    const ext102 = seed.extensions[`${fqdn}/102`];
    if (ext101 === undefined || ext102 === undefined) throw new Error('tenantA was not seeded');
    for (let i = 0; i < CALLS; i++) {
      await clearRegistration(`101@${fqdn}`);
      await clearRegistration(`102@${fqdn}`);
      const uas = startUas({
        au: '102',
        ap: ext102.password,
        authUri: fqdn,
        csvLine: `102;${fqdn}`,
        containerName: `sip-test-dispatch-${label}-uas-${String(i)}`,
      });
      try {
        await uas.ready();
        const caller = await runForeground({
          scenario: 'uac_call.xml',
          csvLine: `101;${fqdn};102`,
          au: '101',
          ap: ext101.password,
          authUri: fqdn,
          containerName: `sip-test-dispatch-${label}-uac-${String(i)}`,
        });
        expect(caller.successfulCalls, caller.stdout).toBe(1);
        await uas.result();
      } finally {
        await stopContainer(uas.containerName);
      }
    }
  }

  async function newCallsPerNode(label: string): Promise<Record<string, number>> {
    const before = await sessionsSinceStartup();
    await placeCalls(label);
    const after = await sessionsSinceStartup();
    return Object.fromEntries(
      Object.entries(after).map(([nodeId, count]) => [
        nodeId,
        (count - (before[nodeId] ?? 0)) / LEGS_PER_CALL,
      ]),
    );
  }

  it('lists both nodes by the ids the dispatcher carries', async () => {
    expect(
      (await dispatcherStates()).map((destination) => [destination.uri, destination.nodeId]),
    ).toEqual([
      ['sip:freeswitch:5060', 'freeswitch'],
      [DRAINED_URI, DRAINED_NODE],
    ]);
    const response = await dockerCurlJson(
      'GET',
      `${CALL_CONTROL_URL}/internal/v1/nodes`,
      undefined,
      internalServiceHeaders(),
    );
    expect(response.status).toBe(200);
    expect((response.json as { nodes: NodeView[] }).nodes).toMatchObject([
      { nodeId: 'freeswitch', status: 'up', draining: false },
      { nodeId: DRAINED_NODE, status: 'up', draining: false },
    ]);
  });

  it('splits new calls by weight: 3 to 1 in any run of four', async () => {
    await opensipsSql(
      "UPDATE dispatcher SET weight = '3' WHERE destination = 'sip:freeswitch:5060'",
    );
    await opensipsMi('ds_reload');

    // Weighted round-robin takes a node `weight` times in a row, so any four consecutive calls
    // split 3:1 wherever the rotation starts.
    expect(await newCallsPerNode('weight')).toEqual({ freeswitch: 3, [DRAINED_NODE]: 1 });
  }, 90_000);

  it('drains a node: no new calls, its leases handed over; undrained, it is back', async () => {
    const tenantId = randomUUID();
    const queueId = randomUUID();
    const leaseUrl = `${CALL_CONTROL_URL}/internal/v1/affinity/${tenantId}/queue/${queueId}`;
    const acquired = await dockerCurlJson(
      'POST',
      `${leaseUrl}/acquire`,
      { preferredNodeId: DRAINED_NODE },
      internalServiceHeaders(),
    );
    expect(acquired.json).toEqual({ nodeId: DRAINED_NODE, acquired: true });

    const drained = await nodeAction('drain');
    expect(drained.node).toMatchObject({ status: 'draining', draining: true, leases: 0 });
    expect(drained.leasesHandedOver).toBeGreaterThanOrEqual(1);
    const owner = await dockerCurlJson('GET', leaseUrl, undefined, internalServiceHeaders());
    expect(owner.json).toEqual({ nodeId: null });

    // telephony-config takes it out of rotation from call-control's event.
    await waitForState(DRAINED_URI, 'Inactive');
    const calls = await newCallsPerNode('drain');
    expect(calls).toEqual({ freeswitch: CALLS, [DRAINED_NODE]: 0 });

    // The queue's next caller re-pins it on a node in service.
    const reacquired = await dockerCurlJson(
      'POST',
      `${leaseUrl}/acquire`,
      {},
      internalServiceHeaders(),
    );
    expect(reacquired.json).toEqual({ nodeId: 'freeswitch', acquired: true });
    await dockerCurlJson('POST', `${leaseUrl}/release`, undefined, internalServiceHeaders());

    const undrained = await nodeAction('undrain');
    expect(undrained.node).toMatchObject({ status: 'up', draining: false });
    await waitForState(DRAINED_URI, 'Active');
  }, 120_000);
});
