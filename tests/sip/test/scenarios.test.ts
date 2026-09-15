import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  clearRegistration,
  runForeground,
  seedFixtures,
  sipInfraOrSkipReason,
  startUas,
  stopContainer,
  uasReceivedCall,
  type SeedResult,
} from '../src/run-scenario.js';

// Skips cleanly on a laptop without the compose stack up, or in the main CI
// `check` job (no compose stack there — only MariaDB/Redis service
// containers); fails loudly instead when `REQUIRE_SIP_TESTS=1` (the
// dedicated `sip-smoke` CI job) — see `sipInfraOrSkipReason`'s own comment.
const skipReason = await sipInfraOrSkipReason();

describe.skipIf(skipReason !== undefined)('S1-14 SIP scenarios', () => {
  let seed: SeedResult;
  const activeContainers = new Set<string>();

  beforeAll(async () => {
    seed = await seedFixtures();
  }, 60_000);

  // One teardown pass at the very end, not `afterEach`: each test uses its
  // own uniquely-named containers (no cross-test reuse), and a `docker rm
  // -f` between every test measurably slowed the Docker daemon down enough
  // in this sandboxed environment to make the *next* test's own SIPp
  // containers miss real SIP transaction timers — confirmed directly (the
  // exact same suite went from "1 failed, 29s" to "4 passed, 9.7s" with
  // per-test cleanup removed and nothing else changed).
  afterAll(async () => {
    await Promise.all([...activeContainers].map((name) => stopContainer(name)));
    activeContainers.clear();
  });

  function ext(realm: string, number: string): { password: string; realm: string } {
    const entry = seed.extensions[`${realm}/${number}`];
    if (entry === undefined) throw new Error(`no seeded extension for ${realm}/${number}`);
    return entry;
  }

  it('completes a real call end to end: 101 registers, calls 102, 102 answers, 101 hangs up', async () => {
    const a101 = ext(seed.tenantA.fqdn, '101');
    const a102 = ext(seed.tenantA.fqdn, '102');
    await clearRegistration(`101@${seed.tenantA.fqdn}`);
    await clearRegistration(`102@${seed.tenantA.fqdn}`);

    const uas = startUas({
      au: '102',
      ap: a102.password,
      authUri: seed.tenantA.fqdn,
      csvLine: `102;${seed.tenantA.fqdn}`,
      containerName: 'sip-test-happy-uas',
    });
    activeContainers.add(uas.containerName);
    await uas.ready();

    const caller = await runForeground({
      scenario: 'uac_call.xml',
      csvLine: `101;${seed.tenantA.fqdn};102`,
      au: '101',
      ap: a101.password,
      authUri: seed.tenantA.fqdn,
      containerName: 'sip-test-happy-uac',
    });
    expect(caller.successfulCalls, caller.stdout).toBe(1);
    expect(caller.failedCalls, caller.stdout).toBe(0);

    const uasResult = await uas.result();
    expect(uasResult.successfulCalls, uasResult.stdout).toBe(1);
  });

  it('routes a call only to the caller tenant, even when another tenant registers the same extension number', async () => {
    const a101 = ext(seed.tenantA.fqdn, '101');
    const a102 = ext(seed.tenantA.fqdn, '102');
    const b102 = ext(seed.tenantB.fqdn, '102');
    await clearRegistration(`101@${seed.tenantA.fqdn}`);
    await clearRegistration(`102@${seed.tenantA.fqdn}`);
    await clearRegistration(`102@${seed.tenantB.fqdn}`);

    const uasA = startUas({
      au: '102',
      ap: a102.password,
      authUri: seed.tenantA.fqdn,
      csvLine: `102;${seed.tenantA.fqdn}`,
      containerName: 'sip-test-iso-uas-a',
    });
    const uasB = startUas({
      au: '102',
      ap: b102.password,
      authUri: seed.tenantB.fqdn,
      csvLine: `102;${seed.tenantB.fqdn}`,
      containerName: 'sip-test-iso-uas-b',
    });
    activeContainers.add(uasA.containerName);
    activeContainers.add(uasB.containerName);
    await Promise.all([uasA.ready(), uasB.ready()]);

    const caller = await runForeground({
      scenario: 'uac_call.xml',
      csvLine: `101;${seed.tenantA.fqdn};102`,
      au: '101',
      ap: a101.password,
      authUri: seed.tenantA.fqdn,
      containerName: 'sip-test-iso-uac',
    });
    expect(caller.successfulCalls, caller.stdout).toBe(1);

    const uasAResult = await uasA.result();
    expect(uasAResult.successfulCalls, uasAResult.stdout).toBe(1);
    // `[field2]` in `uac_call.xml` is always the bare number — this
    // scenario cannot express "reach tenant B's namespace" at all, which is
    // 03 §3.2's own point (`X-Tenant-Id` comes from the trusted
    // registration, never the R-URI). Confirming tenant B's UAS never saw
    // an INVITE is what actually proves isolation held.
    expect(await uasReceivedCall(uasB.containerName)).toBe(false);
  });

  it('ignores a spoofed X-Tenant-Id header on the INVITE and still routes by the real registration', async () => {
    const a101 = ext(seed.tenantA.fqdn, '101');
    const a102 = ext(seed.tenantA.fqdn, '102');
    const b102 = ext(seed.tenantB.fqdn, '102');
    await clearRegistration(`101@${seed.tenantA.fqdn}`);
    await clearRegistration(`102@${seed.tenantA.fqdn}`);
    await clearRegistration(`102@${seed.tenantB.fqdn}`);

    const uasA = startUas({
      au: '102',
      ap: a102.password,
      authUri: seed.tenantA.fqdn,
      csvLine: `102;${seed.tenantA.fqdn}`,
      containerName: 'sip-test-spoof-uas-a',
    });
    const uasB = startUas({
      au: '102',
      ap: b102.password,
      authUri: seed.tenantB.fqdn,
      csvLine: `102;${seed.tenantB.fqdn}`,
      containerName: 'sip-test-spoof-uas-b',
    });
    activeContainers.add(uasA.containerName);
    activeContainers.add(uasB.containerName);
    await Promise.all([uasA.ready(), uasB.ready()]);

    // OpenSIPs strips any inbound `X-Tenant-Id` unconditionally before
    // setting its own (`opensips.cfg.template`'s `remove_hf` at the top of
    // `route{}`) — this spoofed value naming tenant B must have zero
    // effect on where the call actually goes.
    const caller = await runForeground({
      scenario: 'uac_call.xml',
      csvLine: `101;${seed.tenantA.fqdn};102`,
      au: '101',
      ap: a101.password,
      authUri: seed.tenantA.fqdn,
      extraHeader: `X-Tenant-Id: ${seed.tenantB.id}`,
      containerName: 'sip-test-spoof-uac',
    });
    expect(caller.successfulCalls, caller.stdout).toBe(1);

    const uasAResult = await uasA.result();
    expect(uasAResult.successfulCalls, uasAResult.stdout).toBe(1);
    expect(await uasReceivedCall(uasB.containerName)).toBe(false);
  });

  it('rejects registration for a suspended tenant before any digest challenge', async () => {
    // No password needed: `route{}`'s REGISTER branch rejects at
    // `is_uri_host_local()` — a suspended tenant's domain is removed from
    // the projection entirely — before any digest challenge is issued.
    await clearRegistration(`103@${seed.tenantSuspended.fqdn}`);

    const result = await runForeground({
      scenario: 'register_expect_reject.xml',
      csvLine: `103;${seed.tenantSuspended.fqdn}`,
      containerName: 'sip-test-suspended',
    });
    expect(result.successfulCalls, result.stdout).toBe(1);
    expect(result.failedCalls, result.stdout).toBe(0);
  });
});
