import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  runForeground,
  seedFixtures,
  sipInfraOrSkipReason,
  stopContainer,
  type SeedResult,
} from '../src/run-scenario.js';

const skipReason = await sipInfraOrSkipReason();

const WATCHER_CONTAINER = 'sip-test-presence-watcher';

/**
 * S2-20 (G-38, docs/decisions.md): `opensips.cfg.template`'s own
 * `is_method("SUBSCRIBE")` branch (S2-17, extension BLF) gets its first
 * live proof here — a genuinely new SIP method shape for this suite
 * (SUBSCRIBE/NOTIFY, no INVITE or REGISTER involved). No
 * `withSingleFsNode` here, unlike every other file in this suite:
 * SUBSCRIBE is handled entirely inside OpenSIPs (`presence`/
 * `pua_dialoginfo`) and never reaches FS at all, so there is no
 * dispatcher/affinity concern to pin around.
 *
 * NARROWED SCOPE: this proves the SUBSCRIBE handshake itself (auth
 * challenge, `$fd`/`$td` tenant-scoping, and — same-tenant only — at
 * least one real NOTIFY reaching the watcher, proof `handle_subscribe()`
 * genuinely accepted the subscription and `presence`'s own notifier fired
 * at least once). It does not attempt the deeper, more expensive proof
 * issue #39's own "Done when" also describes — a presentity's own dialog
 * state actually transitioning through early/confirmed/terminated and
 * each transition producing its own distinct NOTIFY body, which needs a
 * *third*, concurrently-running SIPp process placing a real call to the
 * presentity while the watcher's own SUBSCRIBE is active. Left as an
 * explicit gap in `docs/decisions.md` G-38 rather than attempted
 * partially and reported as done.
 */
describe.skipIf(skipReason !== undefined)('S2-17 presence / BLF (live SIPp, G-38)', () => {
  let seed: SeedResult;

  beforeAll(async () => {
    seed = await seedFixtures();
  }, 60_000);

  afterEach(async () => {
    await stopContainer(WATCHER_CONTAINER);
  });

  it('a same-tenant SUBSCRIBE is accepted and receives a NOTIFY', async () => {
    const tenantFqdn = seed.tenantPresence.fqdn;
    const ext601 = seed.extensions[`${tenantFqdn}/601`];
    if (ext601 === undefined) throw new Error('tenantPresence/601 was not seeded');

    const result = await runForeground({
      scenario: 'subscribe_dialog_info.xml',
      csvLine: `601;${tenantFqdn};602;${tenantFqdn}`,
      au: '601',
      ap: ext601.password,
      authUri: tenantFqdn,
      containerName: WATCHER_CONTAINER,
    });
    expect(result.successfulCalls, result.stdout).toBe(1);
  }, 30_000);

  it("a cross-tenant SUBSCRIBE for another tenant's presentity is rejected (403)", async () => {
    const tenantA = seed.tenantA;
    const ext101 = seed.extensions[`${tenantA.fqdn}/101`];
    if (ext101 === undefined) throw new Error('tenantA/101 was not seeded');
    const presenceFqdn = seed.tenantPresence.fqdn;

    const result = await runForeground({
      scenario: 'subscribe_dialog_info_expect_403.xml',
      csvLine: `101;${tenantA.fqdn};602;${presenceFqdn}`,
      au: '101',
      ap: ext101.password,
      authUri: tenantA.fqdn,
      containerName: WATCHER_CONTAINER,
    });
    expect(result.successfulCalls, result.stdout).toBe(1);
  }, 30_000);
});
