import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  clearRegistration,
  dockerCurlJson,
  runForeground,
  seedFixtures,
  setTenantLimits,
  sipInfraOrSkipReason,
  startBackgroundUas,
  startDelayedCaller,
  stopContainer,
  type SeedResult,
} from '../src/run-scenario.js';

const skipReason = await sipInfraOrSkipReason();

const TRUNK_SERVICE_URL = 'http://trunk-service:8080';
const CARRIER_CONTAINER = 'sip-test-fraud-carrier';
const HELD_CALLER_CONTAINER = 'sip-test-fraud-held-caller';
const CALLER_CONTAINER = 'sip-test-fraud-caller';

interface CreatedTrunk {
  readonly id: string;
}
interface CreatedOutboundRoute {
  readonly id: string;
}

/**
 * S2-05's own acceptance test, verified against a real compose stack — the
 * same "run the literal SIPp scenario the plan's own 'Done when' describes"
 * discipline every S2 telephony task has established. Both halves of this
 * task's "Done when": "SIPp shows call N+1 over the channel limit
 * rejected, and an international call rejected by default."
 *
 * Uses `seed.tenantFraud`, not `seed.tenantOutbound` (S2-04's own file) —
 * kept separate so the two files' tests never race to mutate the same
 * tenant's `orgs.limits` via `setTenantLimits`.
 */
describe.skipIf(skipReason !== undefined)('S2-05 toll-fraud controls', () => {
  let seed: SeedResult;

  beforeAll(async () => {
    seed = await seedFixtures();
  }, 60_000);

  afterEach(async () => {
    await Promise.all(
      [CARRIER_CONTAINER, HELD_CALLER_CONTAINER, CALLER_CONTAINER].map((name) =>
        stopContainer(name),
      ),
    );
  });

  async function createIpTrunk(
    tenantId: string,
    host: string,
    port: number,
  ): Promise<CreatedTrunk> {
    const created = await dockerCurlJson(
      'POST',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks`,
      { name: 'S2-05 carrier', authMode: 'ip', host, port, transport: 'udp', codecs: ['PCMU'] },
    );
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    return created.json as CreatedTrunk;
  }

  async function deleteTrunk(tenantId: string, trunkId: string): Promise<void> {
    await dockerCurlJson('DELETE', `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks/${trunkId}`);
  }

  async function createOutboundRoute(
    tenantId: string,
    trunkIds: readonly string[],
    pattern: string,
  ): Promise<CreatedOutboundRoute> {
    const created = await dockerCurlJson(
      'POST',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/outbound-routes`,
      { priority: 0, pattern, trunkIds, strip: 0, prepend: null },
    );
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    return created.json as CreatedOutboundRoute;
  }

  async function deleteOutboundRoute(tenantId: string, routeId: string): Promise<void> {
    await dockerCurlJson(
      'DELETE',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/outbound-routes/${routeId}`,
    );
  }

  it('rejects a call over the tenant concurrent-channel limit', async () => {
    const tenantId = seed.tenantFraud.id;
    const tenantFqdn = seed.tenantFraud.fqdn;
    const ext105 = seed.extensions[`${tenantFqdn}/105`];
    if (ext105 === undefined) throw new Error('tenantFraud/105 was not seeded');
    await clearRegistration(`105@${tenantFqdn}`);

    const carrier = startBackgroundUas('carrier_answer.xml', CARRIER_CONTAINER, 5093);
    await carrier.ready();

    let trunk: CreatedTrunk | undefined;
    let route: CreatedOutboundRoute | undefined;
    try {
      trunk = await createIpTrunk(tenantId, CARRIER_CONTAINER, 5093);
      route = await createOutboundRoute(tenantId, [trunk.id], '+1');
      // Same event-driven-projection settling window S2-04's own outbound
      // test uses.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await setTenantLimits(tenantId, { maxConcurrentChannels: 1 });

      // Held open for 4s (`uac_call_hold.xml`) — long enough for the
      // second call attempt below to land while this one still occupies
      // the tenant's only allowed channel.
      const held = await startDelayedCaller({
        scenario: 'uac_call_hold.xml',
        csvLine: `105;${tenantFqdn};+14155552671`,
        au: '105',
        ap: ext105.password,
        authUri: tenantFqdn,
        containerName: HELD_CALLER_CONTAINER,
      });

      // Real time for the held call's own register+invite+200+ack round
      // trip to complete and its channel to actually count against the
      // limit, before the second attempt fires.
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const rejected = await runForeground({
        scenario: 'uac_call.xml',
        csvLine: `105;${tenantFqdn};+14155552671`,
        au: '105',
        ap: ext105.password,
        authUri: tenantFqdn,
        containerName: CALLER_CONTAINER,
      });
      expect(rejected.successfulCalls, rejected.stdout).toBe(0);

      const heldResult = await held.result();
      expect(heldResult.successfulCalls, heldResult.stdout).toBe(1);
    } finally {
      await carrier.stop();
      if (route !== undefined) await deleteOutboundRoute(tenantId, route.id);
      if (trunk !== undefined) await deleteTrunk(tenantId, trunk.id);
      await setTenantLimits(tenantId, {});
    }
  }, 45_000);

  it('blocks an international call by default', async () => {
    const tenantId = seed.tenantFraud.id;
    const tenantFqdn = seed.tenantFraud.fqdn;
    const ext105 = seed.extensions[`${tenantFqdn}/105`];
    if (ext105 === undefined) throw new Error('tenantFraud/105 was not seeded');
    await clearRegistration(`105@${tenantFqdn}`);

    const carrier = startBackgroundUas('carrier_answer.xml', CARRIER_CONTAINER, 5093);
    await carrier.ready();

    let trunk: CreatedTrunk | undefined;
    let route: CreatedOutboundRoute | undefined;
    try {
      trunk = await createIpTrunk(tenantId, CARRIER_CONTAINER, 5093);
      // Catch-all: a GB number must reach the fraud check, not 404 for
      // "no route matches" instead.
      route = await createOutboundRoute(tenantId, [trunk.id], '');
      await new Promise((resolve) => setTimeout(resolve, 2000));
      // No limits set at all — international-off is this tenant's default,
      // not something a test has to opt into.
      await setTenantLimits(tenantId, {});

      // libphonenumber's own documented example UK number (`e164.test.ts`).
      const result = await runForeground({
        scenario: 'uac_call.xml',
        csvLine: `105;${tenantFqdn};+442079460958`,
        au: '105',
        ap: ext105.password,
        authUri: tenantFqdn,
        containerName: CALLER_CONTAINER,
      });
      expect(result.successfulCalls, result.stdout).toBe(0);
    } finally {
      await carrier.stop();
      if (route !== undefined) await deleteOutboundRoute(tenantId, route.id);
      if (trunk !== undefined) await deleteTrunk(tenantId, trunk.id);
    }
  }, 30_000);
});
