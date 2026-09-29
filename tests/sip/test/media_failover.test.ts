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
const CALLER = 'sip-test-mediafail-801';
const PERSON = 'sip-test-mediafail-802';
const MEDIA_PORT = ['-mp', '7000'];

interface LiveLeg {
  readonly callUuid: string;
  readonly state: string;
}

interface Relay {
  readonly packets: number;
  readonly own: number;
  readonly foreign: number;
}

/**
 * S4-10, live: the media of a call in progress survives an edge failover. 801 calls 802 and both
 * stream audio through the active edge's RTPengine; the other edge's relay follows the call
 * through Redis (a `foreign` session, bound on the same floating addresses). The active edge is
 * killed: the floating addresses move, the survivor carries the audio from then on, and the call
 * is ended normally through it.
 */
describe.skipIf(skipReason !== undefined)('S4-10 media survives an edge failover (live)', () => {
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
    if (killed === undefined) return;
    await execFileAsync('docker', ['start', killed]).catch(() => undefined);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const { stdout } = await execFileAsync('docker', [
        'inspect',
        '-f',
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

  async function relay(container: string): Promise<Relay> {
    const { stdout: ip } = await execFileAsync('docker', [
      'inspect',
      '-f',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      container,
    ]);
    const { stdout } = await execFileAsync('docker', [
      'exec',
      container,
      'python3',
      '-c',
      `import urllib.request;print(urllib.request.urlopen('http://${ip.trim()}:9101/metrics').read().decode())`,
    ]);
    const metric = (pattern: RegExp) => Number(pattern.exec(stdout)?.[1] ?? NaN);
    return {
      packets: metric(/^rtpengine_packets_total\{type="userspace"\} (\d+)/m),
      own: metric(/^rtpengine_sessions\{type="own"\} (\d+)/m),
      foreign: metric(/^rtpengine_sessions\{type="foreign"\} (\d+)/m),
    };
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

  it('keeps the audio of a call in progress flowing through the surviving edge', async () => {
    for (const number of ['801', '802']) await clearRegistration(`${number}@${fqdn}`);
    const active = await activeOpensipsContainer();
    const survivor = sipTestEnv().opensipsContainers.find((c) => c !== active)!;

    const person = startUas({
      au: '802',
      ap: password('802'),
      authUri: fqdn,
      csvLine: `802;${fqdn}`,
      containerName: PERSON,
      answerScenario: 'answer_call_rtp.xml',
      extraArgs: MEDIA_PORT,
    });
    await person.ready();
    const caller = await startDelayedCaller({
      scenario: 'uac_call_rtp_long.xml',
      csvLine: `801;${fqdn};802`,
      au: '801',
      ap: password('801'),
      authUri: fqdn,
      containerName: CALLER,
      extraArgs: MEDIA_PORT,
    });

    let talking: LiveLeg[] = [];
    await expect
      .poll(
        async () => {
          talking = (await legs()).filter((leg) => leg.state === 'answered');
          return talking.length;
        },
        { timeout: 20_000, interval: 250 },
      )
      .toBeGreaterThanOrEqual(2);

    // The survivor already holds both legs' sessions, and relays nothing yet.
    await expect.poll(async () => (await relay(survivor)).foreign, { timeout: 10_000 }).toBe(2);
    const idle = await relay(survivor);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect((await relay(survivor)).packets).toBe(idle.packets);

    // The active edge dies; the survivor carries the audio from then on.
    killed = active;
    await execFileAsync('docker', ['kill', active]);
    await expect.poll(() => activeOpensipsContainer(), { timeout: 15_000 }).toBe(survivor);
    const takenOver = await relay(survivor);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    // 5 s of 50 packets a second on each of four streams (two legs, both ways), give or take.
    expect((await relay(survivor)).packets - takenOver.packets).toBeGreaterThan(500);

    // The call ends normally through the survivor, which then lets its sessions go.
    const node = await nodeOf(talking[0]!.callUuid);
    await fsCliOn(node, `uuid_kill ${talking[0]!.callUuid}`);
    const [callerResult, personResult] = await Promise.all([caller.result(), person.result()]);
    expect(callerResult.successfulCalls, callerResult.stdout).toBe(1);
    expect(personResult.successfulCalls, personResult.stdout).toBe(1);
    await expect
      .poll(
        async () => {
          const after = await relay(survivor);
          return after.own + after.foreign;
        },
        { timeout: 20_000 },
      )
      .toBe(0);
  }, 180_000);

  async function nodeOf(callUuid: string): Promise<string> {
    for (const container of sipTestEnv().freeswitchContainers) {
      const found = await fsCliOn(container, `uuid_exists ${callUuid}`).catch(() => '');
      if (found.trim() === 'true') return container;
    }
    throw new Error(`no node has ${callUuid}`);
  }
});
