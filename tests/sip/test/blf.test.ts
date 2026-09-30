import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  clearRegistration,
  seedFixtures,
  sipInfraOrSkipReason,
  startDelayedCaller,
  startUas,
  stopContainer,
  type SeedResult,
} from '../src/run-scenario.js';

const skipReason = await sipInfraOrSkipReason();

const CALLER = 'sip-test-blf-801';
const PERSON = 'sip-test-blf-802';
const WATCH_CALLER = 'sip-test-blf-watch-801';
const WATCH_PERSON = 'sip-test-blf-watch-802';

/** The dialog states in the NOTIFY bodies a watcher received, in order (`-message_file`). */
function dialogStates(log: string): string[] {
  return [...log.matchAll(/<state[^>]*>([a-z]+)<\/state>/g)].map((match) => match[1]!);
}

/**
 * S2-17 (G-38), live: a colleague's BLF key follows a call. 803 watches 801 and 802 (`dialog`
 * state), and 801 calls 802. Each watcher must be told the extension's call is confirmed and
 * later terminated: 801's from its own call to the media node (the edge marks the caller side),
 * 802's from the media node's call to its phone (the callee side). The edge publishes each
 * change to itself and notifies the watchers.
 */
describe.skipIf(skipReason !== undefined)('S2-17 BLF follows a call (live SIPp)', () => {
  let seed: SeedResult;
  let fqdn: string;

  beforeAll(async () => {
    seed = await seedFixtures();
    fqdn = seed.tenantCalls.fqdn;
  }, 60_000);

  afterEach(async () => {
    await Promise.all(
      [CALLER, PERSON, WATCH_CALLER, WATCH_PERSON].map((name) => stopContainer(name)),
    );
  });

  function password(number: string): string {
    const entry = seed.extensions[`${fqdn}/${number}`];
    if (entry === undefined) throw new Error(`no seeded extension ${number}`);
    return entry.password;
  }

  function watch(number: string, containerName: string) {
    return startDelayedCaller({
      scenario: 'subscribe_dialog_states.xml',
      csvLine: `803;${fqdn};${number}`,
      au: '803',
      ap: password('803'),
      authUri: fqdn,
      containerName,
      extraArgs: ['-trace_msg', '-message_file', '/proc/self/fd/1'],
    });
  }

  it('shows the caller and the person called busy during the call, and idle after', async () => {
    for (const number of ['801', '802']) await clearRegistration(`${number}@${fqdn}`);
    const person = startUas({
      au: '802',
      ap: password('802'),
      authUri: fqdn,
      csvLine: `802;${fqdn}`,
      containerName: PERSON,
    });
    await person.ready();
    const watchers = [await watch('801', WATCH_CALLER), await watch('802', WATCH_PERSON)];
    // Both subscriptions in place (each is answered with the idle state first).
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const caller = await startDelayedCaller({
      scenario: 'uac_call_hold.xml',
      csvLine: `801;${fqdn};802`,
      au: '801',
      ap: password('801'),
      authUri: fqdn,
      containerName: CALLER,
    });
    const [callerResult, personResult] = await Promise.all([caller.result(), person.result()]);
    expect(callerResult.successfulCalls, callerResult.stdout).toBe(1);
    expect(personResult.successfulCalls, personResult.stdout).toBe(1);

    for (const watcher of watchers) {
      // A watcher ends by waiting out its last NOTIFY, which SIPp counts as a failed call; what
      // it was told is the result.
      const watched = await watcher.result();
      expect(dialogStates(watched.stdout), watched.stdout).toEqual(
        expect.arrayContaining(['confirmed', 'terminated']),
      );
      const states = dialogStates(watched.stdout);
      expect(states.lastIndexOf('terminated')).toBeGreaterThan(states.indexOf('confirmed'));
    }
  }, 120_000);
});
