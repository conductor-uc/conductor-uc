import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  clearRegistration,
  fsCliOn,
  seedFixtures,
  sipInfraOrSkipReason,
  sipTestEnv,
  startDelayedCaller,
  startUas,
  stopContainer,
  type SeedResult,
} from '../src/run-scenario.js';

const skipReason = await sipInfraOrSkipReason();

const CALLER = 'sip-test-codec-801';
const PERSON = 'sip-test-codec-802';
/** Each phone's RTP port, apart from its SIP port. */
const MEDIA_PORT = ['-mp', '7000'];

interface Leg {
  readonly direction: string;
  readonly read_codec: string;
  readonly cid_num: string;
}

/**
 * G-134, live: the phone called is offered the caller's codec first and then the rest of the
 * node's list (`media_mix_inbound_outbound_codecs`, vars.xml), not the caller's codec alone.
 *
 * 801 offers Opus first and G.711, as a softphone does, and the platform answers it Opus. Called
 * is a phone that speaks only G.711: it must be offered G.711 (its scenario fails otherwise, as
 * the phone would refuse the call), it answers G.711, and the media node converts between the
 * two legs. Called is a phone that speaks Opus: it answers Opus, the caller's codec, and nothing
 * is converted.
 */
describe.skipIf(skipReason !== undefined)("G-134 the called leg's codecs (live)", () => {
  let seed: SeedResult;
  let fqdn: string;

  beforeAll(async () => {
    seed = await seedFixtures();
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

  /** 801's legs on the media nodes now: each leg's direction and codec. */
  async function legs(): Promise<string[]> {
    const found: string[] = [];
    for (const node of sipTestEnv().freeswitchContainers) {
      const shown = JSON.parse(await fsCliOn(node, 'show channels as json')) as { rows?: Leg[] };
      for (const row of shown.rows ?? []) {
        if (row.cid_num === '801') found.push(`${row.direction} ${row.read_codec}`);
      }
    }
    return found.sort();
  }

  /** 801, offering Opus then G.711, calls 802, who answers with `answerScenario`. */
  async function call(answerScenario: string, expected: readonly string[]): Promise<void> {
    for (const number of ['801', '802']) await clearRegistration(`${number}@${fqdn}`);
    const person = startUas({
      au: '802',
      ap: password('802'),
      authUri: fqdn,
      csvLine: `802;${fqdn}`,
      containerName: PERSON,
      answerScenario,
      extraArgs: MEDIA_PORT,
    });
    await person.ready();
    const caller = await startDelayedCaller({
      scenario: 'uac_call_opus_first.xml',
      csvLine: `801;${fqdn};802`,
      au: '801',
      ap: password('801'),
      authUri: fqdn,
      containerName: CALLER,
      extraArgs: MEDIA_PORT,
    });

    // While the call is up (6 s), each leg's codec on the media node.
    await expect.poll(() => legs(), { timeout: 20_000, interval: 250 }).toEqual(expected);

    const [callerResult, personResult] = await Promise.all([caller.result(), person.result()]);
    expect(callerResult.successfulCalls, callerResult.stdout).toBe(1);
    expect(personResult.successfulCalls, personResult.stdout).toBe(1);
  }

  it('reaches a phone that speaks only G.711, converting on the media node', async () => {
    await call('answer_call_pcmu_only.xml', ['inbound opus', 'outbound PCMU']);
  }, 90_000);

  it('converts nothing when the phone called speaks the caller’s codec', async () => {
    await call('answer_call_opus.xml', ['inbound opus', 'outbound opus']);
  }, 90_000);
});
