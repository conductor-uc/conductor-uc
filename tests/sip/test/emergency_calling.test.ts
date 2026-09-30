import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  dockerCurlJson,
  clearRegistration,
  tenantAdminCurlJson,
  runForeground,
  seedFixtures,
  setTenantLimits,
  sipInfraOrSkipReason,
  startBackgroundUas,
  startDelayedCaller,
  stopContainer,
  waitForProjected,
  type SeedResult,
} from '../src/run-scenario.js';

const skipReason = await sipInfraOrSkipReason();

const TRUNK_SERVICE_URL = 'http://trunk-service:8080';
/** The stack's mail catcher, as the suite's curl container reaches it. */
const MAILPIT_URL = 'http://mailpit:8025';
const CARRIER_CONTAINER = 'sip-test-emergency-carrier';
const HELD_CALLER_CONTAINER = 'sip-test-emergency-held-caller';
const EMERGENCY_CALLER_CONTAINER = 'sip-test-emergency-caller';

interface CreatedTrunk {
  readonly id: string;
}
interface CreatedOutboundRoute {
  readonly id: string;
}

/**
 * S2-06's own acceptance test, verified against a real compose stack — the
 * same "run the literal SIPp scenario the plan's own 'Done when' describes"
 * discipline every S2 telephony task has established. This covers the half
 * of that "Done when" only a live stack can actually prove: "an emergency
 * number reaches the emergency trunk even when the tenant is at its channel
 * limit." The other half, the notification, is checked here too since G-1's
 * email exists: the emergency route lists an address, and the call must put an
 * email about it in the stack's Mailpit (notification-service, through
 * `call.emergency.initiated`). The console alert is covered by the gateway's
 * and the console's own tests.
 *
 * Uses `seed.tenantEmergency`, not `tenantFraud`/`tenantOutbound` — kept
 * separate for the same reason those two are kept apart from each other
 * (`toll_fraud.test.ts`'s own doc comment): this test also calls
 * `setTenantLimits`, and creates its own trunk/routes no other test should
 * see.
 */
describe.skipIf(skipReason !== undefined)('S2-06 emergency calling', () => {
  let seed: SeedResult;

  beforeAll(async () => {
    seed = await seedFixtures();
  }, 60_000);

  afterEach(async () => {
    await Promise.all(
      [CARRIER_CONTAINER, HELD_CALLER_CONTAINER, EMERGENCY_CALLER_CONTAINER].map((name) =>
        stopContainer(name),
      ),
    );
  });

  async function createIpTrunk(
    tenantId: string,
    host: string,
    port: number,
  ): Promise<CreatedTrunk> {
    const created = await tenantAdminCurlJson(
      seed.resellerId,
      'POST',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks`,
      {
        name: 'S2-06 E911 carrier',
        authMode: 'ip',
        host,
        port,
        transport: 'udp',
        codecs: ['PCMU'],
      },
    );
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    return created.json as CreatedTrunk;
  }

  async function deleteTrunk(tenantId: string, trunkId: string): Promise<void> {
    await tenantAdminCurlJson(
      seed.resellerId,
      'DELETE',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks/${trunkId}`,
    );
  }

  async function createOutboundRoute(
    tenantId: string,
    trunkIds: readonly string[],
    pattern: string,
  ): Promise<CreatedOutboundRoute> {
    const created = await tenantAdminCurlJson(
      seed.resellerId,
      'POST',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/outbound-routes`,
      { priority: 0, pattern, trunkIds, strip: 0, prepend: null },
    );
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    return created.json as CreatedOutboundRoute;
  }

  async function deleteOutboundRoute(tenantId: string, routeId: string): Promise<void> {
    await tenantAdminCurlJson(
      seed.resellerId,
      'DELETE',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/outbound-routes/${routeId}`,
    );
  }

  async function putEmergencyRoute(
    tenantId: string,
    trunkId: string,
    numbers: readonly string[],
    notifyEmails: readonly string[] = [],
  ): Promise<void> {
    const result = await tenantAdminCurlJson(
      seed.resellerId,
      'PUT',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/emergency-route`,
      { trunkId, numbers, notifyEmails },
    );
    expect(result.status, JSON.stringify(result.json)).toBe(200);
  }

  async function deleteEmergencyRoute(tenantId: string): Promise<void> {
    await tenantAdminCurlJson(
      seed.resellerId,
      'DELETE',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/emergency-route`,
    );
  }

  it('bridges a call to the emergency number even though the tenant is already at its concurrent-channel limit', async () => {
    const tenantId = seed.tenantEmergency.id;
    const tenantFqdn = seed.tenantEmergency.fqdn;
    const ext106 = seed.extensions[`${tenantFqdn}/106`];
    if (ext106 === undefined) throw new Error('tenantEmergency/106 was not seeded');
    await clearRegistration(`106@${tenantFqdn}`);

    const carrier = startBackgroundUas('carrier_answer.xml', CARRIER_CONTAINER, 5094);
    await carrier.ready();

    let trunk: CreatedTrunk | undefined;
    let route: CreatedOutboundRoute | undefined;
    let emergencyRouteCreated = false;
    // S2-06 (G-1): who is emailed when someone dials an emergency number.
    const frontDesk = `front-desk-${crypto.randomUUID()}@example.test`;
    try {
      trunk = await createIpTrunk(tenantId, CARRIER_CONTAINER, 5094);
      // A normal outbound route — this is what the *held* call below rides,
      // to actually occupy the tenant's one allowed channel. The emergency
      // route below is what the 911 call rides; both name the same
      // underlying trunk/carrier, since nothing about this test needs them
      // to be different carriers, and G-1 never requires a dedicated one.
      route = await createOutboundRoute(tenantId, [trunk.id], '+1');
      await putEmergencyRoute(tenantId, trunk.id, ['911'], [frontDesk]);
      emergencyRouteCreated = true;
      // Wait for telephony-config's copy of the outbound and emergency routes.
      await waitForProjected('outbound_routes', 'id', route.id);
      await waitForProjected('emergency_routes', 'trunk_id', trunk.id);
      await setTenantLimits(tenantId, { maxConcurrentChannels: 1 });

      // Held open for 4s (`uac_call_hold.xml`) — long enough for the
      // emergency call below to land while this one still occupies the
      // tenant's only allowed channel.
      const held = await startDelayedCaller({
        scenario: 'uac_call_hold.xml',
        csvLine: `106;${tenantFqdn};+14155552671`,
        au: '106',
        ap: ext106.password,
        authUri: tenantFqdn,
        containerName: HELD_CALLER_CONTAINER,
      });

      // Real time for the held call's own register+invite+200+ack round
      // trip to complete and its channel to actually count against the
      // limit, before the emergency call attempt fires.
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const emergency = await runForeground({
        scenario: 'uac_call.xml',
        csvLine: `106;${tenantFqdn};911`,
        au: '106',
        ap: ext106.password,
        authUri: tenantFqdn,
        containerName: EMERGENCY_CALLER_CONTAINER,
      });
      // The bypass itself: an *ordinary* second call here would be rejected
      // (`toll_fraud.test.ts`'s own "rejects a call over the tenant
      // concurrent-channel limit" test, same held-call shape) — this one,
      // dialed through the emergency route instead, must not be.
      expect(emergency.successfulCalls, emergency.stdout).toBe(1);

      // And the held call was never torn down or otherwise disturbed by the
      // emergency call sharing its carrier — the limit really was occupied,
      // not merely unset.
      const heldResult = await held.result();
      expect(heldResult.successfulCalls, heldResult.stdout).toBe(1);

      // The on-site notification reached the address on the route.
      await expect
        .poll(
          async () => {
            const found = await dockerCurlJson(
              'GET',
              `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${frontDesk}"`)}`,
            );
            return ((found.json as { messages?: { Subject: string }[] }).messages ?? []).map(
              (message) => message.Subject,
            );
          },
          { timeout: 20_000, interval: 500 },
        )
        .toEqual([expect.stringContaining('Emergency call: 911 dialled from 106')]);
    } finally {
      await carrier.stop();
      if (emergencyRouteCreated) await deleteEmergencyRoute(tenantId);
      if (route !== undefined) await deleteOutboundRoute(tenantId, route.id);
      if (trunk !== undefined) await deleteTrunk(tenantId, trunk.id);
      await setTenantLimits(tenantId, {});
    }
  }, 45_000);
});
