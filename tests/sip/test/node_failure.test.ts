import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  clearRegistration,
  composeContainer,
  dispatcherStates,
  dockerCurlJson,
  internalServiceHeaders,
  opensipsMi,
  seedFixtures,
  sipInfraOrSkipReason,
  startDelayedCaller,
  startUas,
  stopContainer,
  tenantAdminCurlJson,
  type SeedResult,
} from '../src/run-scenario.js';

const execFileAsync = promisify(execFile);
const skipReason = await sipInfraOrSkipReason();

const CALL_CONTROL_URL = 'http://call-control:8080';
const CDR_SERVICE_URL = 'http://cdr-service:8080';
const CALLER = 'sip-test-nodefail-801';
const PERSON = 'sip-test-nodefail-802';
/** The node this test kills: the second one, so the rest of the suite keeps its first. */
const NODE = 'freeswitch-2';
const NODE_URI = `sip:${NODE}:5060`;
const NODE_CONTAINER = composeContainer('freeswitch-2');

interface LiveLeg {
  readonly callUuid: string;
  readonly extension: string | null;
  readonly state: string;
  readonly bridgedTo: string | null;
}

/**
 * S4-04, live (04 §4): a media node dies in the middle of a call. 801 calls 802 through
 * `freeswitch-2` alone, and the node is killed. Within its heartbeat's expiry both phones get a
 * BYE from the edge (their dialogs ended by Call-ID), the legs leave the live list, and each leg
 * gets a `node_failure` call record. The node is then started again and rejoins.
 */
describe.skipIf(skipReason !== undefined)('S4-04 a media node dies mid-call (live)', () => {
  let seed: SeedResult;
  let tenantId: string;
  let fqdn: string;
  let others: string[] = [];

  beforeAll(async () => {
    seed = await seedFixtures();
    tenantId = seed.tenantCalls.id;
    fqdn = seed.tenantCalls.fqdn;
  }, 120_000);

  afterEach(async () => {
    await Promise.all([CALLER, PERSON].map((name) => stopContainer(name)));
  });

  afterAll(async () => {
    // Whatever happened, the node comes back and every node takes calls again.
    await execFileAsync('docker', ['start', NODE_CONTAINER]).catch(() => undefined);
    for (const uri of others) await opensipsMi('ds_set_state', 'a', '1', uri);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const state = (await dispatcherStates()).find((d) => d.uri === NODE_URI)?.state;
      if (state === 'Active') return;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }, 150_000);

  function password(number: string): string {
    const entry = seed.extensions[`${fqdn}/${number}`];
    if (entry === undefined) throw new Error(`no seeded extension ${number}`);
    return entry.password;
  }

  async function legs(): Promise<LiveLeg[]> {
    const response = await dockerCurlJson(
      'GET',
      `${CALL_CONTROL_URL}/internal/v1/tenants/${tenantId}/calls`,
      undefined,
      internalServiceHeaders(),
    );
    return (response.json as { calls?: LiveLeg[] }).calls ?? [];
  }

  it('ends both parties, forgets the legs, and records each as a node failure', async () => {
    // Only freeswitch-2 takes the call.
    others = (await dispatcherStates()).map((d) => d.uri).filter((uri) => uri !== NODE_URI);
    for (const uri of others) await opensipsMi('ds_set_state', 'i', '1', uri);
    for (const number of ['801', '802']) await clearRegistration(`${number}@${fqdn}`);

    const person = startUas({
      au: '802',
      ap: password('802'),
      authUri: fqdn,
      csvLine: `802;${fqdn}`,
      containerName: PERSON,
    });
    await person.ready();
    const caller = await startDelayedCaller({
      scenario: 'uac_call_hold_long.xml',
      csvLine: `801;${fqdn};802`,
      au: '801',
      ap: password('801'),
      authUri: fqdn,
      containerName: CALLER,
    });

    const callStartedAt = Date.now();
    let talking: LiveLeg[] = [];
    await expect
      .poll(
        async () => {
          talking = (await legs()).filter((leg) => leg.state === 'answered');
          return talking.length;
        },
        { timeout: 30_000, interval: 500 },
      )
      .toBeGreaterThanOrEqual(2);
    const lostUuids = talking.map((leg) => leg.callUuid);

    const killedAt = Date.now();
    await execFileAsync('docker', ['kill', NODE_CONTAINER]);

    // Both phones are sent a BYE by the edge, well before their own 45 s / 60 s timers.
    const [callerResult, personResult] = await Promise.all([caller.result(), person.result()]);
    const endedAfter = (Date.now() - killedAt) / 1000;
    expect(callerResult.successfulCalls).toBe(1);
    expect(personResult.successfulCalls).toBe(1);
    // The heartbeat's 10 s expiry, the watcher's next second, and the event to the edge.
    expect(endedAfter).toBeLessThan(20);

    // The legs are gone from the live list at once.
    const now = (await legs()).map((leg) => leg.callUuid);
    for (const uuid of lostUuids) expect(now).not.toContain(uuid);

    // Each lost leg has its node-failure record (the list does not name calls by UUID, so the
    // records are this tenant's node failures that started with this call).
    await expect
      .poll(
        async () => {
          const response = await tenantAdminCurlJson(
            seed.resellerId,
            'GET',
            `${CDR_SERVICE_URL}/v1/tenants/${tenantId}/cdrs?limit=50`,
          );
          const rows = (response.json as { rows?: { startAt: string; disposition: string }[] })
            .rows;
          return (rows ?? []).filter(
            (row) =>
              row.disposition === 'node_failure' &&
              new Date(row.startAt).getTime() >= callStartedAt - 2_000,
          ).length;
        },
        { timeout: 30_000, interval: 1_000 },
      )
      .toBe(lostUuids.length);
    // eslint-disable-next-line no-console
    console.log(`S4-04: both parties ended ${endedAfter.toFixed(1)} s after the node died`);
  }, 180_000);
});
