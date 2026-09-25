import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  clearRegistration,
  tenantAdminCurlJson,
  runForeground,
  seedFixtures,
  sipInfraOrSkipReason,
  startBackgroundUas,
  stopContainer,
  uasReceivedCall,
  type SeedResult,
} from '../src/run-scenario.js';

const skipReason = await sipInfraOrSkipReason();

const TRUNK_SERVICE_URL = 'http://trunk-service:8080';

const PRIMARY_CONTAINER = 'sip-test-outbound-carrier-primary';
const SECONDARY_CONTAINER = 'sip-test-outbound-carrier-secondary';
const CALLER_CONTAINER = 'sip-test-outbound-caller';

interface CreatedTrunk {
  readonly id: string;
}
interface CreatedOutboundRoute {
  readonly id: string;
}

/**
 * S2-04's own acceptance test, verified against a real compose stack — the
 * same "run the literal SIPp scenario the plan's own 'Done when' describes"
 * discipline S2-01/S2-02/S2-03 established. Two trunks in one outbound
 * route's priority order; the first ("primary") rejects every INVITE with
 * 503 (`carrier_reject_503.xml`), and `failure_route[outbound_gw]`
 * (`opensips.cfg.template`) must call `use_next_gw()` and complete the call
 * on the second ("secondary", `carrier_answer.xml`).
 *
 * Uses `seed.tenantOutbound`, not the shared `tenantA`/`tenantB` every other
 * SIP suite reuses — see `seed.ts`'s own comment on `tenantOutbound`: those
 * two predate `tenants.country` (migration `005_add_outbound_routing`) in
 * every environment this suite has ever run against, and there is no
 * backfill for a tenant whose `org.tenant.created` was consumed before that
 * column existed, so their local country mirror is permanently `NULL`.
 *
 * The two "carrier" containers are addressed by their own compose-network
 * container name as the trunk's `host` (Docker's embedded per-network DNS
 * resolves it, the same way every service in `docker-compose.yml` addresses
 * every other one by service name) — no IP-inspection dance like
 * `startDelayedCaller`'s is needed, since these are outbound *destinations*,
 * never a source `check_source_address` has to match.
 */
describe.skipIf(skipReason !== undefined)('S2-04 outbound failover', () => {
  let seed: SeedResult;

  beforeAll(async () => {
    seed = await seedFixtures();
  }, 60_000);

  afterEach(async () => {
    await Promise.all(
      [PRIMARY_CONTAINER, SECONDARY_CONTAINER, CALLER_CONTAINER].map((name) => stopContainer(name)),
    );
  });

  async function createIpTrunk(
    tenantId: string,
    host: string,
    port: number,
    name: string,
  ): Promise<CreatedTrunk> {
    const created = await tenantAdminCurlJson(
      seed.resellerId,
      'POST',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks`,
      { name, authMode: 'ip', host, port, transport: 'udp', codecs: ['PCMU'] },
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
  ): Promise<CreatedOutboundRoute> {
    const created = await tenantAdminCurlJson(
      seed.resellerId,
      'POST',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/outbound-routes`,
      { priority: 0, pattern: '+1', trunkIds, strip: 0, prepend: null },
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

  it('fails over to the secondary trunk on 503', async () => {
    const tenantId = seed.tenantOutbound.id;
    const tenantFqdn = seed.tenantOutbound.fqdn;
    const ext104 = seed.extensions[`${tenantFqdn}/104`];
    if (ext104 === undefined) throw new Error('tenantOutbound/104 was not seeded');
    // `usrloc`/`subscriber` are DB-persisted (`run-scenario.ts`'s own
    // `clearRegistration` comment): a stale registration from an earlier,
    // interrupted run of this same suite can make a fresh REGISTER fail with
    // "Invalid CSeq number" — every other SIP suite file clears defensively
    // before registering, regardless of whether the AOR looks first-time.
    await clearRegistration(`104@${tenantFqdn}`);

    const primary = startBackgroundUas('carrier_reject_503.xml', PRIMARY_CONTAINER, 5091);
    const secondary = startBackgroundUas('carrier_answer.xml', SECONDARY_CONTAINER, 5092);
    await Promise.all([primary.ready(), secondary.ready()]);

    let trunkPrimary: CreatedTrunk | undefined;
    let trunkSecondary: CreatedTrunk | undefined;
    let route: CreatedOutboundRoute | undefined;
    try {
      trunkPrimary = await createIpTrunk(
        tenantId,
        PRIMARY_CONTAINER,
        5091,
        'S2-04 primary (down) trunk',
      );
      trunkSecondary = await createIpTrunk(
        tenantId,
        SECONDARY_CONTAINER,
        5092,
        'S2-04 secondary (up) trunk',
      );

      // `projectOutboundRoute` (`projection.ts`) looks up each trunk via
      // this service's own *local* `trunks` read model
      // (`readModel.findTrunkById`) — a trunk whose own `trunk.trunk.created`
      // hasn't been consumed and projected yet is silently skipped (an
      // "honest miss," not an error; found live: without this wait, the
      // route-created event can race ahead of one or both trunk-created
      // events and the route projects with only the trunk that won the
      // race, so the 503 side is never actually dialed at all — not a
      // failover bug, a missing settling window before this test's own
      // route-creation call). Both trunk HTTP calls above only wait for
      // trunk-service's own write+outbox-publish, not for telephony-config
      // to have consumed either event yet.
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Priority order matters: `dr_rules.gwlist` is tried in this exact
      // order (`opensips-projection.repo.ts`'s `upsertDrRule`, `sort_alg`
      // left at the table's own default `'N'`) — primary first, so the 503
      // it always sends is what actually triggers failover, not a race.
      route = await createOutboundRoute(tenantId, [trunkPrimary.id, trunkSecondary.id]);

      // Same reasoning as above, now for the route's own projection to
      // land before the call below depends on it.
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const caller = await runForeground({
        scenario: 'uac_call.xml',
        // libphonenumber's own documented example number (`e164.test.ts`) —
        // a real, validly-formatted NANP number. A "555-XXXX" one fails
        // `isValid()` and 404s before ever reaching outbound routing.
        csvLine: `104;${tenantFqdn};+14155552671`,
        au: '104',
        ap: ext104.password,
        authUri: tenantFqdn,
        containerName: CALLER_CONTAINER,
      });
      expect(caller.successfulCalls, caller.stdout).toBe(1);
      expect(caller.failedCalls, caller.stdout).toBe(0);

      // `uasReceivedCall` reads a `startBackgroundUas` container's own
      // periodic stats-screen redraw out of `docker logs` — real, but not
      // necessarily flushed the instant the call above finishes. A short,
      // generous wait (same idiom as this file's own projection-lag pause)
      // before checking both.
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Both trunks must actually have been dialed — proves this was a real
      // failover, not (say) `dr_rules.gwlist` ordering happening to put the
      // secondary first.
      expect(await uasReceivedCall(PRIMARY_CONTAINER)).toBe(true);
      expect(await uasReceivedCall(SECONDARY_CONTAINER)).toBe(true);
    } finally {
      await primary.stop();
      await secondary.stop();
      if (route !== undefined) await deleteOutboundRoute(tenantId, route.id);
      if (trunkPrimary !== undefined) await deleteTrunk(tenantId, trunkPrimary.id);
      if (trunkSecondary !== undefined) await deleteTrunk(tenantId, trunkSecondary.id);
    }
  }, 45_000);
});
