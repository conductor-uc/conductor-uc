import { afterEach, beforeAll, describe, expect, it } from 'vitest';

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

const skipReason = await sipInfraOrSkipReason();

const CALLER = 'sip-test-auth-caller';
const PERSON = 'sip-test-auth-802';

/**
 * Every call a phone starts is authenticated (opensips.cfg.template, `proxy_authorize`), as its
 * REGISTER is. Found while building S4-09: before this, an INVITE naming a tenant's domain in
 * From was routed with no credentials at all, so anyone who could reach the edge could call as
 * any tenant, out through its trunks included. Here the callee, 802, is registered and would
 * ring for any call that got through.
 */
describe.skipIf(skipReason !== undefined)('phone calls are authenticated (live)', () => {
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

  async function registeredCallee() {
    await clearRegistration(`802@${fqdn}`);
    const person = startUas({
      au: '802',
      ap: password('802'),
      authUri: fqdn,
      csvLine: `802;${fqdn}`,
      containerName: PERSON,
    });
    await person.ready();
    return person;
  }

  it('challenges a call without credentials, and routes nothing', async () => {
    await registeredCallee();
    const result = await runForeground({
      scenario: 'uac_invite_unauthenticated.xml',
      csvLine: `801;${fqdn};802`,
      containerName: CALLER,
    });
    // Succeeds only on the 407.
    expect(result.successfulCalls, result.stdout).toBe(1);
    expect(await uasReceivedCall(PERSON)).toBe(false);
  });

  it('refuses a phone that authenticates as one extension and calls as another', async () => {
    await registeredCallee();
    const result = await runForeground({
      scenario: 'uac_call_as_other.xml',
      csvLine: `803;${fqdn};802`,
      au: '801',
      ap: password('801'),
      authUri: fqdn,
      containerName: CALLER,
    });
    // Succeeds only on the 403.
    expect(result.successfulCalls, result.stdout).toBe(1);
    expect(await uasReceivedCall(PERSON)).toBe(false);
  });
});
