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
 * limit." The other half — "a notification event is emitted" — is
 * unit-tested precisely against the real outbox row shape in
 * `services/telephony-config/test/fs.routes.test.ts`'s own S2-06 block;
 * `call.emergency.initiated` has no consumer yet (docs/decisions.md), so
 * there is no live, black-box-observable side effect for a SIPp scenario to
 * check here beyond what that unit test already proves against the exact
 * same code path (`handleEmergencyDial`).
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
    const created = await dockerCurlJson(
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

  async function putEmergencyRoute(
    tenantId: string,
    trunkId: string,
    numbers: readonly string[],
  ): Promise<void> {
    const result = await dockerCurlJson(
      'PUT',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/emergency-route`,
      { trunkId, numbers },
    );
    expect(result.status, JSON.stringify(result.json)).toBe(200);
  }

  async function deleteEmergencyRoute(tenantId: string): Promise<void> {
    await dockerCurlJson('DELETE', `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/emergency-route`);
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
    try {
      trunk = await createIpTrunk(tenantId, CARRIER_CONTAINER, 5094);
      // A normal outbound route — this is what the *held* call below rides,
      // to actually occupy the tenant's one allowed channel. The emergency
      // route below is what the 911 call rides; both name the same
      // underlying trunk/carrier, since nothing about this test needs them
      // to be different carriers, and G-1 never requires a dedicated one.
      route = await createOutboundRoute(tenantId, [trunk.id], '+1');
      await putEmergencyRoute(tenantId, trunk.id, ['911']);
      emergencyRouteCreated = true;
      // Same event-driven-projection settling window S2-04/S2-05's own
      // outbound tests use — one more event to settle here than theirs
      // (trunk, outbound route, *and* emergency route).
      await new Promise((resolve) => setTimeout(resolve, 2500));
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
    } finally {
      await carrier.stop();
      if (emergencyRouteCreated) await deleteEmergencyRoute(tenantId);
      if (route !== undefined) await deleteOutboundRoute(tenantId, route.id);
      if (trunk !== undefined) await deleteTrunk(tenantId, trunk.id);
      await setTenantLimits(tenantId, {});
    }
  }, 45_000);
});
