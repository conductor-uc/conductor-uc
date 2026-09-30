import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  clearRegistration,
  composeContainer,
  dispatcherStates,
  fsCliOn,
  opensipsMi,
  runForeground,
  seedFixtures,
  sipInfraOrSkipReason,
  startDelayedCaller,
  stopContainer,
  tenantAdminCurlJson,
  waitForProjected,
  waitForTrunkRemoved,
  type SeedResult,
} from '../src/run-scenario.js';

const execFileAsync = promisify(execFile);
const skipReason = await sipInfraOrSkipReason();

const PBX_CONFIG_SERVICE_URL = 'http://pbx-config-service:8080';
const CDR_SERVICE_URL = 'http://cdr-service:8080';
const FIRST_URI = 'sip:freeswitch:5060';
const FIRST_CONTAINER = composeContainer('freeswitch');
const OWNER_URI = 'sip:freeswitch-2:5060';
const OWNER_CONTAINER = composeContainer('freeswitch-2');
const CALLERS = ['sip-test-affinity-1', 'sip-test-affinity-2', 'sip-test-affinity-3'] as const;
const FORGER = 'sip-test-affinity-forged';
const QUEUE_CALLERS = [
  'sip-test-affinity-q1',
  'sip-test-affinity-q2',
  'sip-test-affinity-q3',
] as const;
const TRUNK_SERVICE_URL = 'http://trunk-service:8080';
/** A carrier addresses OpenSIPs' own trunk termination point (as `queue.test.ts` does). */
const CARRIER_TARGET_DOMAIN = 'opensips';
const ROOM_NUMBER = '905';

/**
 * S4-05, live (04 §3.3): a conference room's callers all reach the one node holding the room,
 * whichever node the edge first gives them. 201 joins through `freeswitch-2` alone, which leases
 * the room. 202 is then given `freeswitch` alone: its node finds the room leased elsewhere and
 * hairpins the call back through OpenSIPs to `freeswitch-2`, where both are in the one
 * conference, and the call leaves one record, not one per node. `freeswitch-2` is then killed:
 * 201 is ended (S4-04), the lease goes with the node, and 203, on `freeswitch`, gets the room
 * there.
 */
describe.skipIf(skipReason !== undefined)('S4-05 affinity routing across nodes (live)', () => {
  let seed: SeedResult;
  let tenantId: string;
  let fqdn: string;
  let roomId: string | undefined;

  beforeAll(async () => {
    seed = await seedFixtures();
    tenantId = seed.tenantConference.id;
    fqdn = seed.tenantConference.fqdn;
  }, 120_000);

  afterEach(async () => {
    await Promise.all([...CALLERS, ...QUEUE_CALLERS, FORGER].map((name) => stopContainer(name)));
  });

  /** Whatever happened, the killed node comes back and every node takes calls again. */
  async function restoreNodes(): Promise<void> {
    await execFileAsync('docker', ['start', OWNER_CONTAINER]).catch(() => undefined);
    // Healthy, not just Active at the edge: setting the state below makes it Active at once,
    // while the node may still be starting (found live: a call sent then was lost).
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const { stdout } = await execFileAsync('docker', [
        'inspect',
        '--format',
        '{{.State.Health.Status}}',
        OWNER_CONTAINER,
      ]).catch(() => ({ stdout: '' }));
      if (stdout.trim() === 'healthy') break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    for (const destination of await dispatcherStates()) {
      await opensipsMi('ds_set_state', 'a', '1', destination.uri);
    }
    // call-control's event socket and heartbeat back on the node.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }

  afterAll(async () => {
    if (roomId !== undefined) {
      await tenantAdminCurlJson(
        seed.resellerId,
        'DELETE',
        `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/conference-rooms/${roomId}`,
      );
    }
    await restoreNodes();
  }, 150_000);

  /** New calls go to `uri` alone. */
  async function onlyNode(uri: string): Promise<void> {
    for (const destination of await dispatcherStates()) {
      await opensipsMi('ds_set_state', destination.uri === uri ? 'a' : 'i', '1', destination.uri);
    }
  }

  function caller(index: 0 | 1 | 2, number: string, scenario: string, startOnSignal = false) {
    const entry = seed.extensions[`${fqdn}/${number}`];
    if (entry === undefined) throw new Error(`no seeded extension ${number}`);
    return startDelayedCaller({
      scenario,
      csvLine: `${number};${fqdn};${ROOM_NUMBER}`,
      au: number,
      ap: entry.password,
      authUri: fqdn,
      containerName: CALLERS[index],
      startOnSignal,
    });
  }

  /** How many are in the room on a node (0 when the node has no such conference). */
  async function members(container: string): Promise<number> {
    const listed = await fsCliOn(container, `conference ${roomId ?? ''} list count`);
    const count = Number(listed.trim());
    return Number.isInteger(count) ? count : 0;
  }

  it('sends a caller on the other node to the room’s node, and re-leases when that node dies', async () => {
    for (const number of ['201', '202', '203']) await clearRegistration(`${number}@${fqdn}`);
    const created = await tenantAdminCurlJson(
      seed.resellerId,
      'POST',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/conference-rooms`,
      { label: 'S4-05 room', number: ROOM_NUMBER, maxMembers: 10 },
    );
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    roomId = (created.json as { id: string }).id;
    await waitForProjected('conference_rooms', 'id', roomId);

    // A phone cannot use the hairpin headers: dialing a number that is no room, with headers
    // naming the room, goes nowhere near it (the edge strips them; the call finds no route).
    const forged = await runForeground({
      scenario: 'uac_call_affinity_forged.xml',
      csvLine: `201;${fqdn};9999;conf:${roomId};${tenantId}`,
      au: '201',
      ap: seed.extensions[`${fqdn}/201`]?.password ?? '',
      authUri: fqdn,
      containerName: FORGER,
    });
    expect(forged.successfulCalls, forged.stdout).toBe(0);
    expect(await members(OWNER_CONTAINER)).toBe(0);
    expect(await members(FIRST_CONTAINER)).toBe(0);

    // 201 lands on freeswitch-2, which leases the room.
    await onlyNode(OWNER_URI);
    const first = await caller(0, '201', 'uac_call_hold_long.xml');
    await expect.poll(() => members(OWNER_CONTAINER), { timeout: 20_000 }).toBe(1);

    // 202 lands on freeswitch and is hairpinned to freeswitch-2.
    await onlyNode(FIRST_URI);
    const secondStartedAt = Date.now();
    const second = await caller(1, '202', 'uac_call_hold.xml');
    await expect.poll(() => members(OWNER_CONTAINER), { timeout: 20_000 }).toBe(2);
    expect(await members(FIRST_CONTAINER)).toBe(0);
    // freeswitch carries 202's call: its leg in, and its leg back out through the edge.
    const channels = await fsCliOn(FIRST_CONTAINER, 'show channels count');
    expect(Number(/(\d+) total/.exec(channels)?.[1] ?? 0)).toBeGreaterThanOrEqual(2);
    const secondResult = await second.result();
    expect(secondResult.successfulCalls, secondResult.stdout).toBe(1);
    await expect.poll(() => members(OWNER_CONTAINER), { timeout: 10_000 }).toBe(1);

    // One call, one record: the node that took it keeps it; the room's node keeps none.
    const recordsOf202 = async () => {
      const response = await tenantAdminCurlJson(
        seed.resellerId,
        'GET',
        `${CDR_SERVICE_URL}/v1/tenants/${tenantId}/cdrs?limit=50`,
      );
      const rows = (response.json as { rows?: { startAt: string; fromNumber: string }[] }).rows;
      return (rows ?? []).filter(
        (row) =>
          row.fromNumber === '202' && new Date(row.startAt).getTime() >= secondStartedAt - 2_000,
      ).length;
    };
    await expect.poll(recordsOf202, { timeout: 30_000, interval: 1_000 }).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await recordsOf202()).toBe(1);

    // 203's phone is created now, held until needed: a container created after the kill can be
    // given the dead node's address on this one flat network, and the edge would take its calls
    // for a media node's (found live).
    const third = await caller(2, '203', 'uac_call_hold.xml', true);

    // freeswitch-2 dies: both are ended by the edge, and its lease with it.
    await execFileAsync('docker', ['kill', OWNER_CONTAINER]);
    const firstResult = await first.result();
    expect(firstResult.successfulCalls, firstResult.stdout).toBe(1);

    // 203, on freeswitch, gets the room there.
    await third.start();
    await expect.poll(() => members(FIRST_CONTAINER), { timeout: 20_000 }).toBe(1);
    const thirdResult = await third.result();
    expect(thirdResult.successfulCalls, thirdResult.stdout).toBe(1);
  }, 180_000);
  /**
   * The plan's own case (S4-05's "Done when"): a queue with a caller waiting on one node keeps
   * receiving new callers there, and after that node dies the next caller leases it elsewhere.
   * Carrier calls to a DID, so it is the DID path that is hairpinned here. No agent is needed:
   * the callers wait in the queue.
   */
  it('keeps a queue’s callers on its node, and re-leases the queue when that node dies', async () => {
    await restoreNodes();
    const queueTenantId = seed.tenantQueue.id;
    const queueFqdn = seed.tenantQueue.fqdn;
    const admin = (method: 'POST' | 'DELETE', path: string, body?: unknown) =>
      tenantAdminCurlJson(seed.resellerId, method, path, body);

    const queue = await admin(
      'POST',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${queueTenantId}/queues`,
      {
        label: 'S4-05 queue',
        strategy: 'ring-all',
        maxWaitSeconds: 60,
        announcePosition: false,
      },
    );
    expect(queue.status, JSON.stringify(queue.json)).toBe(201);
    const queueId = (queue.json as { id: string }).id;
    const queueName = `${queueId}@${queueFqdn}`;
    let trunkId: string | undefined;
    let didId: string | undefined;
    try {
      await waitForProjected('queues', 'id', queueId);
      const e164 = `+1555888${String(Math.floor(1000 + Math.random() * 9000))}`;

      // Every caller's container is made first, so none can be given the killed node's address.
      const callers = await Promise.all(
        QUEUE_CALLERS.map((containerName) =>
          startDelayedCaller({
            scenario: 'trunk_invite_hold_long.xml',
            csvLine: `carrier;${CARRIER_TARGET_DOMAIN};${e164}`,
            containerName,
            startOnSignal: true,
          }),
        ),
      );
      const [first, second, third] = callers as [
        (typeof callers)[number],
        (typeof callers)[number],
        (typeof callers)[number],
      ];
      const trunk = await admin('POST', `${TRUNK_SERVICE_URL}/v1/tenants/${queueTenantId}/trunks`, {
        name: 'S4-05 carrier',
        authMode: 'ip',
        host: first.ip,
        port: 5060,
        transport: 'udp',
        codecs: ['PCMU'],
      });
      expect(trunk.status, JSON.stringify(trunk.json)).toBe(201);
      trunkId = (trunk.json as { id: string }).id;
      for (const caller of callers) {
        const added = await admin(
          'POST',
          `${TRUNK_SERVICE_URL}/v1/tenants/${queueTenantId}/trunks/${trunkId}/ips`,
          { cidr: `${caller.ip}/32` },
        );
        expect(added.status, JSON.stringify(added.json)).toBe(201);
      }
      const did = await admin(
        'POST',
        `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${queueTenantId}/dids`,
        {
          e164,
          trunkId,
          destinationType: 'queue',
          destinationId: queueId,
        },
      );
      expect(did.status, JSON.stringify(did.json)).toBe(201);
      didId = (did.json as { id: string }).id;

      const waiting = async (container: string) => {
        const counted = await fsCliOn(
          container,
          `callcenter_config queue count members ${queueName}`,
        );
        const count = Number(counted.trim());
        return Number.isInteger(count) ? count : 0;
      };

      // The first caller lands on freeswitch-2, which leases the queue.
      await onlyNode(OWNER_URI);
      await first.startWhenRouted({ trunkId, didId });
      await expect.poll(() => waiting(OWNER_CONTAINER), { timeout: 20_000 }).toBe(1);

      // The second lands on freeswitch and waits in the same queue on freeswitch-2.
      await onlyNode(FIRST_URI);
      await second.start();
      await expect.poll(() => waiting(OWNER_CONTAINER), { timeout: 20_000 }).toBe(2);
      expect(await waiting(FIRST_CONTAINER)).toBe(0);

      // freeswitch-2 dies; the third caller, on freeswitch, has the queue leased there.
      await execFileAsync('docker', ['kill', OWNER_CONTAINER]);
      await Promise.all([first.result(), second.result()]);
      await third.start();
      await expect.poll(() => waiting(FIRST_CONTAINER), { timeout: 20_000 }).toBe(1);
      const thirdResult = await third.result();
      expect(thirdResult.successfulCalls, thirdResult.stdout).toBe(1);
    } finally {
      if (didId !== undefined) {
        await admin(
          'DELETE',
          `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${queueTenantId}/dids/${didId}`,
        );
      }
      if (trunkId !== undefined) {
        await admin('DELETE', `${TRUNK_SERVICE_URL}/v1/tenants/${queueTenantId}/trunks/${trunkId}`);
        await waitForTrunkRemoved(trunkId);
      }
      await admin(
        'DELETE',
        `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${queueTenantId}/queues/${queueId}`,
      );
    }
  }, 240_000);
});
