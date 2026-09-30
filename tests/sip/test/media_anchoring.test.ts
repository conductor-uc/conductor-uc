import { afterEach, beforeAll, describe, expect, it } from 'vitest';

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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const skipReason = await sipInfraOrSkipReason();

const CALL_CONTROL_URL = 'http://call-control:8080';
const CALLER = 'sip-test-media-801';
const PERSON = 'sip-test-media-802';
/** Each phone's RTP port, apart from its SIP port. */
const MEDIA_PORT = ['-mp', '7000'];
/** The edge pair's floating address facing the media nodes (compose's OPENSIPS_INTERNAL_VIP). */
const INTERNAL_VIP = sipTestEnv().opensipsInternalVip;

interface LiveLeg {
  readonly callUuid: string;
  readonly state: string;
}

/**
 * S4-10 (O-7, decided: RTPengine on the edge pair), live: 801 calls 802 and both stream audio.
 * Each phone is offered the edge's floating address, never a media node's (the scenarios check
 * the SDP they receive); the media node's legs send and receive at the pair's private floating
 * address;
 * the edge's RTPengine relays the packets, and forgets the call when it ends.
 */
describe.skipIf(skipReason !== undefined)('S4-10 media anchored at the edge (live)', () => {
  let seed: SeedResult;
  let tenantId: string;
  let fqdn: string;

  beforeAll(async () => {
    seed = await seedFixtures();
    tenantId = seed.tenantCalls.id;
    fqdn = seed.tenantCalls.fqdn;
  }, 120_000);

  afterEach(async () => {
    await Promise.all([CALLER, PERSON].map((name) => stopContainer(name)));
  });

  function password(number: string): string {
    const entry = seed.extensions[`${fqdn}/${number}`];
    if (entry === undefined) throw new Error(`no seeded extension ${number}`);
    return entry.password;
  }

  async function ownIp(container: string): Promise<string> {
    const { stdout } = await execFileAsync('docker', [
      'inspect',
      '-f',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      container,
    ]);
    return stdout.trim();
  }

  /** The edge's RTPengine counters (Prometheus text): `sessions` counts closed ones. */
  async function relay(
    container: string,
  ): Promise<{ packets: number; sessions: number; own: number }> {
    const ip = await ownIp(container);
    const { stdout } = await execFileAsync('docker', [
      'exec',
      container,
      'python3',
      '-c',
      `import urllib.request;print(urllib.request.urlopen('http://${ip}:9101/metrics').read().decode())`,
    ]);
    const metric = (pattern: RegExp) => Number(pattern.exec(stdout)?.[1] ?? NaN);
    return {
      packets: metric(/^rtpengine_packets_total\{type="userspace"\} (\d+)/m),
      sessions: metric(/^rtpengine_sessions_total (\d+)/m),
      own: metric(/^rtpengine_sessions\{type="own"\} (\d+)/m),
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

  it("anchors both legs' media at the edge", async () => {
    for (const number of ['801', '802']) await clearRegistration(`${number}@${fqdn}`);
    const edge = await activeOpensipsContainer();
    const before = await relay(edge);

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
      scenario: 'uac_call_rtp.xml',
      csvLine: `801;${fqdn};802`,
      au: '801',
      ap: password('801'),
      authUri: fqdn,
      containerName: CALLER,
      extraArgs: MEDIA_PORT,
    });

    // While the call is up, the media node's legs exchange media with the edge, not the phones.
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
    for (const leg of talking) {
      let remote = '';
      for (const node of sipTestEnv().freeswitchContainers) {
        const answer = await fsCliOn(node, `uuid_getvar ${leg.callUuid} remote_media_ip`).catch(
          () => '',
        );
        if (/^\d+\.\d+\.\d+\.\d+$/.test(answer.trim())) remote = answer.trim();
      }
      expect(remote, leg.callUuid).toBe(INTERNAL_VIP);
    }

    // Both phones saw only the floating address (their scenarios check it) and completed.
    const [callerResult, personResult] = await Promise.all([caller.result(), person.result()]);
    expect(callerResult.successfulCalls, callerResult.stdout).toBe(1);
    expect(personResult.successfulCalls, personResult.stdout).toBe(1);

    // The edge relayed the audio of both legs (4 s of 50 packets a second, each way, at least),
    // and closes both sessions once the call has ended (after its 5 s `delete-delay`, which
    // absorbs a retransmitted BYE).
    expect((await relay(edge)).packets - before.packets).toBeGreaterThan(300);
    await expect
      .poll(async () => (await relay(edge)).sessions - before.sessions, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2);
    expect((await relay(edge)).own).toBe(before.own);
  }, 120_000);
});
