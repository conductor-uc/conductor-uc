import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  activeOpensipsContainer,
  clearRegistration,
  dockerCurlJson,
  fsCliOn,
  internalServiceHeaders,
  seedFixtures,
  sipInfraOrSkipReason,
  sipTestEnv,
  startDelayedCaller,
  startUas,
  stopContainer,
  type SeedResult,
} from '../src/run-scenario.js';

const execFileAsync = promisify(execFile);
const skipReason = await sipInfraOrSkipReason();

const CALL_CONTROL_URL = 'http://call-control:8080';
const VIP = '172.18.255.10';
const CALLER = 'sip-test-edge-801';
const CALLER_AGAIN = 'sip-test-edge-801b';
const PERSON = 'sip-test-edge-802';
const COLLEAGUE = 'sip-test-edge-803';

interface LiveLeg {
  readonly callUuid: string;
  readonly state: string;
}

/**
 * S4-06, live (04 §2, the plan's "Done when"): killing the active OpenSIPs keeps established
 * calls up, phones stay registered without registering again, and new calls succeed once the
 * floating address has moved. 801 calls 802 while 803 sits registered; the edge holding the
 * floating address is killed. The other edge takes the address. The call is still up and is
 * then ended from the media node: its BYEs reach both phones through the surviving edge, which
 * knows the dialog only from replication. Then 801 calls 803, which registered only with the
 * edge that died.
 */
describe.skipIf(skipReason !== undefined)('S4-06 the edge pair fails over (live)', () => {
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
    await Promise.all([CALLER, CALLER_AGAIN, PERSON, COLLEAGUE].map((name) => stopContainer(name)));
  });

  afterAll(async () => {
    if (killed === undefined) return;
    await execFileAsync('docker', ['start', killed]).catch(() => undefined);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const { stdout } = await execFileAsync('docker', [
        'inspect',
        '--format',
        '{{.State.Health.Status}}',
        killed,
      ]).catch(() => ({ stdout: '' }));
      if (stdout.trim() === 'healthy') return;
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

  async function holdsVip(container: string): Promise<boolean> {
    const { stdout } = await execFileAsync('docker', [
      'exec',
      container,
      'ip',
      '-4',
      '-o',
      'addr',
      'show',
    ]).catch(() => ({ stdout: '' }));
    return stdout.includes(` ${VIP}/`);
  }

  it('keeps the call, the registrations and new calls through a failover', async () => {
    for (const number of ['801', '802', '803']) await clearRegistration(`${number}@${fqdn}`);
    const person = startUas({
      au: '802',
      ap: password('802'),
      authUri: fqdn,
      csvLine: `802;${fqdn}`,
      containerName: PERSON,
    });
    const colleague = startUas({
      au: '803',
      ap: password('803'),
      authUri: fqdn,
      csvLine: `803;${fqdn}`,
      containerName: COLLEAGUE,
    });
    await Promise.all([person.ready(), colleague.ready()]);
    const caller = await startDelayedCaller({
      scenario: 'uac_call_hold_long.xml',
      csvLine: `801;${fqdn};802`,
      au: '801',
      ap: password('801'),
      authUri: fqdn,
      containerName: CALLER,
    });
    // Made now, held until needed: a container made after the kill could be given its address.
    const callerAgain = await startDelayedCaller({
      scenario: 'uac_call.xml',
      csvLine: `801;${fqdn};803`,
      au: '801',
      ap: password('801'),
      authUri: fqdn,
      containerName: CALLER_AGAIN,
      startOnSignal: true,
    });

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

    // The active edge dies; the other takes the floating address.
    const active = await activeOpensipsContainer();
    const survivor = sipTestEnv().opensipsContainers.find((container) => container !== active);
    expect(survivor).toBeDefined();
    expect(await holdsVip(active)).toBe(true);
    killed = active;
    const killedAt = Date.now();
    await execFileAsync('docker', ['kill', active]);
    await expect.poll(() => holdsVip(survivor!), { timeout: 15_000, interval: 250 }).toBe(true);
    await expect.poll(() => activeOpensipsContainer(), { timeout: 10_000 }).toBe(survivor);
    const movedAfter = (Date.now() - killedAt) / 1000;

    // The call is still up.
    const now = (await legs()).map((leg) => leg.callUuid);
    for (const leg of talking) expect(now).toContain(leg.callUuid);

    // Ended from the media node: the BYEs reach both phones through the surviving edge.
    const node = await nodeOf(talking[0]!.callUuid);
    await fsCliOn(node, `uuid_kill ${talking[0]!.callUuid}`);
    const [callerResult, personResult] = await Promise.all([caller.result(), person.result()]);
    expect(callerResult.successfulCalls, callerResult.stdout).toBe(1);
    expect(personResult.successfulCalls, personResult.stdout).toBe(1);

    // 803 registered only with the edge that died, and is still reachable.
    await callerAgain.start();
    const [againResult, colleagueResult] = await Promise.all([
      callerAgain.result(),
      colleague.result(),
    ]);
    expect(againResult.successfulCalls, againResult.stdout).toBe(1);
    expect(colleagueResult.successfulCalls, colleagueResult.stdout).toBe(1);
    // eslint-disable-next-line no-console
    console.log(`S4-06: the other edge was active ${movedAfter.toFixed(1)} s after the first died`);
  }, 180_000);

  /** The FreeSWITCH container the call's leg is on. */
  async function nodeOf(callUuid: string): Promise<string> {
    for (const container of sipTestEnv().freeswitchContainers) {
      const found = await fsCliOn(container, `uuid_exists ${callUuid}`).catch(() => '');
      if (found.trim() === 'true') return container;
    }
    throw new Error(`no node has ${callUuid}`);
  }
});
