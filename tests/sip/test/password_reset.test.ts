import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  clearRegistration,
  resetExtensionPassword,
  runForeground,
  seedFixtures,
  sipInfraOrSkipReason,
  stopContainer,
  type SeedResult,
} from '../src/run-scenario.js';

const skipReason = await sipInfraOrSkipReason();

/**
 * Resetting an extension's SIP password reaches OpenSIPs: the old password is
 * refused and the new one registers. The reset itself is pbx-config-service's
 * repo (the code behind the console's Reset password); everything after it is
 * the live chain: outbox relay, NATS, telephony-config, the `subscriber` table.
 */
describe.skipIf(skipReason !== undefined)('SIP password reset', () => {
  let seed: SeedResult;
  const containers = new Set<string>();

  beforeAll(async () => {
    seed = await seedFixtures();
  }, 60_000);

  afterAll(async () => {
    await Promise.all([...containers].map((name) => stopContainer(name)));
  });

  async function register(password: string, name: string) {
    containers.add(name);
    await clearRegistration(`107@${seed.tenantA.fqdn}`);
    return runForeground({
      scenario: 'register.xml',
      csvLine: `107;${seed.tenantA.fqdn}`,
      au: '107',
      ap: password,
      authUri: seed.tenantA.fqdn,
      containerName: name,
    });
  }

  it('refuses the old password and accepts the new one once the change reaches OpenSIPs', async () => {
    const before = seed.extensions[`${seed.tenantA.fqdn}/107`];
    if (before === undefined) throw new Error('the seed has no extension 107 for tenant A');

    const first = await register(before.password, 'sip-test-reset-before');
    expect(first.successfulCalls, first.stdout).toBe(1);

    const reset = await resetExtensionPassword(seed.tenantA.id, '107');
    expect(reset.password).not.toBe(before.password);
    expect(reset.realm).toBe(seed.tenantA.fqdn);

    // The projection is asynchronous (outbox, bus, consumer), so the new
    // password is retried until OpenSIPs has it.
    let accepted = false;
    let last = '';
    for (let attempt = 0; attempt < 15 && !accepted; attempt += 1) {
      const result = await register(reset.password, `sip-test-reset-after-${String(attempt)}`);
      accepted = result.successfulCalls === 1;
      last = result.stdout;
      if (!accepted) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    expect(accepted, last).toBe(true);

    const stale = await register(before.password, 'sip-test-reset-old');
    expect(stale.successfulCalls, stale.stdout).toBe(0);
    expect(stale.failedCalls, stale.stdout).toBe(1);
  }, 120_000);
});
