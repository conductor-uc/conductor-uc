import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  callControlSql,
  clearRegistration,
  composeContainer,
  dispatcherStates,
  dockerCurlJson,
  fsCliOn,
  internalServiceHeaders,
  opensipsMi,
  redisGet,
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
const REPLICAS = [composeContainer('call-control'), composeContainer('call-control-2')];
const KEY_PREFIX = 'cuc:dev:';
/** The call is kept on the first node, whichever replica owns it. */
const NODE = 'freeswitch';
const NODE_URI = 'sip:freeswitch:5060';
const NODE_CONTAINER = composeContainer('freeswitch');
const CALLER = 'sip-test-ha-801';
const PERSON = 'sip-test-ha-802';

interface LiveLeg {
  readonly callUuid: string;
  readonly state: string;
}

/**
 * S4-03, live (04 §2, 10 §3): two call-control replicas, each media node owned by one. A call is
 * placed through `freeswitch` and each of its legs is written to the outbox once, not once per
 * replica. The replica owning the node is then killed mid-call: the other takes the node within
 * the heartbeat's 10 s, the node is not declared dead (no `node_failure` record, the call stays
 * in the live list), and the node's events flow again: the call's hangup reaches the live list.
 */
describe.skipIf(skipReason !== undefined)('S4-03 call-control replicas (live)', () => {
  let seed: SeedResult;
  let tenantId: string;
  let fqdn: string;
  let killed: string | undefined;

  beforeAll(async () => {
    seed = await seedFixtures();
    tenantId = seed.tenantCalls.id;
    fqdn = seed.tenantCalls.fqdn;
  }, 120_000);

  afterEach(async () => {
    await Promise.all([CALLER, PERSON].map((name) => stopContainer(name)));
  });

  afterAll(async () => {
    if (killed !== undefined) await execFileAsync('docker', ['start', killed]);
    for (const destination of await dispatcherStates()) {
      await opensipsMi('ds_set_state', 'a', '1', destination.uri);
    }
  }, 60_000);

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

  /** The container of the replica that owns the node now. */
  async function ownerContainer(): Promise<string | undefined> {
    const owner = await redisGet(`${KEY_PREFIX}nodeowner:${NODE}`);
    if (owner === undefined) return undefined;
    for (const container of REPLICAS) {
      const { stdout } = await execFileAsync('docker', [
        'inspect',
        '--format',
        '{{.Config.Hostname}}',
        container,
      ]);
      if (owner.startsWith(`${stdout.trim()}:`)) return container;
    }
    return undefined;
  }

  it('writes each event once, and hands a node over mid-call when its replica dies', async () => {
    for (const uri of (await dispatcherStates()).map((d) => d.uri)) {
      await opensipsMi('ds_set_state', uri === NODE_URI ? 'a' : 'i', '1', uri);
    }
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
    const startedAt = Date.now();

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
    const uuids = talking.map((leg) => leg.callUuid);

    // Both replicas receive the node's events; only its owner writes them.
    for (const uuid of uuids) {
      const created = await callControlSql(
        `SELECT COUNT(*) FROM outbox WHERE type = 'call.channel.created' AND payload LIKE '%${uuid}%'`,
      );
      expect(Number(created), uuid).toBe(1);
    }

    // The node's owner dies mid-call.
    const owner = await ownerContainer();
    expect(owner).toBeDefined();
    killed = owner;
    const killedAt = Date.now();
    await execFileAsync('docker', ['kill', owner!]);

    // The other replica takes the node well inside the heartbeat's 10 s expiry.
    const survivor = REPLICAS.find((container) => container !== owner);
    await expect.poll(() => ownerContainer(), { timeout: 10_000, interval: 250 }).toBe(survivor);
    const tookOverAfter = (Date.now() - killedAt) / 1000;

    // Past the expiry, the node is still alive, and so is the call.
    await new Promise((resolve) => setTimeout(resolve, 12_000 - (Date.now() - killedAt)));
    const stillUp = (await legs()).map((leg) => leg.callUuid);
    for (const uuid of uuids) expect(stillUp).toContain(uuid);

    // The node's events flow through the new owner: the hangup empties the live list.
    await fsCliOn(NODE_CONTAINER, `uuid_kill ${uuids[0]!}`);
    const [callerResult, personResult] = await Promise.all([caller.result(), person.result()]);
    expect(callerResult.successfulCalls, callerResult.stdout).toBe(1);
    expect(personResult.successfulCalls, personResult.stdout).toBe(1);
    await expect
      .poll(
        async () => {
          const now = (await legs()).map((leg) => leg.callUuid);
          return uuids.filter((uuid) => now.includes(uuid)).length;
        },
        { timeout: 10_000, interval: 500 },
      )
      .toBe(0);

    // And nothing was taken for a node failure.
    const response = await tenantAdminCurlJson(
      seed.resellerId,
      'GET',
      `${CDR_SERVICE_URL}/v1/tenants/${tenantId}/cdrs?limit=50`,
    );
    const rows = (response.json as { rows?: { startAt: string; disposition: string }[] }).rows;
    expect(
      (rows ?? []).filter(
        (row) =>
          row.disposition === 'node_failure' &&
          new Date(row.startAt).getTime() >= startedAt - 2_000,
      ),
    ).toEqual([]);
    // eslint-disable-next-line no-console
    console.log(
      `S4-03: the node had a new owner ${tookOverAfter.toFixed(1)} s after its replica died`,
    );
  }, 180_000);
});
