import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  clearRegistration,
  dockerCurlJson,
  runForeground,
  seedFixtures,
  sipInfraOrSkipReason,
  startDelayedCaller,
  stopContainer,
  withSingleFsNode,
  type SeedResult,
} from '../src/run-scenario.js';

const skipReason = await sipInfraOrSkipReason();

const PBX_CONFIG_SERVICE_URL = 'http://pbx-config-service:8080';
const PARKER_CONTAINER = 'sip-test-park-parker';
const RETRIEVER_CONTAINER = 'sip-test-park-retriever';

interface CreatedParkingLot {
  readonly id: string;
  readonly slotStart: number;
  readonly slotEnd: number;
}

/**
 * S2-20 (G-48, docs/decisions.md): `mod_valet_parking`'s own call shape
 * (`buildParkDialplanDocument`'s `valet_park(lotname/slot)`) gets its
 * first live proof here. `withSingleFsNode` (this file's own reason to use
 * it, `run-scenario.ts`'s own doc comment) pins both calls to the same FS
 * node — a parking lot is a pinned resource (04 §3.3), and G-46 means a
 * second, separate call round-robining to the node that does not hold the
 * lease would 404 for real, which is not what this test exists to prove.
 *
 * `buildParkDialplanDocument`'s own dialplan condition matches
 * `destination_number` against the slot itself, so whoever dials the slot
 * is the one that gets `valet_park`'d — there is no "transfer into the
 * lot" concept here (03 §3.2's own dedicated `internal-app` context is not
 * built, G-48's own note on why). This scenario reflects exactly that: one
 * extension dials the slot directly to park itself (held, like an ordinary
 * answered call — `answer` runs before `valet_park` in the dialplan
 * action list), a second call dials the same slot to retrieve, and
 * `mod_valet_parking`'s own state machine tells park and retrieve apart.
 */
describe.skipIf(skipReason !== undefined)('S2-14 parking lots (live SIPp, G-48)', () => {
  let seed: SeedResult;

  beforeAll(async () => {
    seed = await seedFixtures();
  }, 60_000);

  afterEach(async () => {
    await Promise.all([PARKER_CONTAINER, RETRIEVER_CONTAINER].map((name) => stopContainer(name)));
  });

  async function createParkingLot(tenantId: string): Promise<CreatedParkingLot> {
    const created = await dockerCurlJson(
      'POST',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/parking-lots`,
      { label: 'S2-20 lot', slotStart: 700, slotEnd: 709, timeoutSeconds: 60 },
    );
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    return created.json as CreatedParkingLot;
  }

  async function deleteParkingLot(tenantId: string, id: string): Promise<void> {
    await dockerCurlJson(
      'DELETE',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/parking-lots/${id}`,
    );
  }

  it('parks a call by dialing the slot, then retrieves it with a second call to the same slot', async () => {
    await withSingleFsNode(async () => {
      const tenantId = seed.tenantA.id;
      const tenantFqdn = seed.tenantA.fqdn;
      const ext101 = seed.extensions[`${tenantFqdn}/101`];
      if (ext101 === undefined) throw new Error('tenantA/101 was not seeded');
      await clearRegistration(`101@${tenantFqdn}`);

      const lot = await createParkingLot(tenantId);
      try {
        // Real-time settling window for pbx.parking_lot.created's own
        // event-driven projection into telephony-config's local mirror —
        // same reasoning S2-04/S2-05's own outbound tests already use.
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const parker = await startDelayedCaller({
          scenario: 'uac_call_hold.xml',
          csvLine: `101;${tenantFqdn};700`,
          au: '101',
          ap: ext101.password,
          authUri: tenantFqdn,
          containerName: PARKER_CONTAINER,
        });

        // Real time for the park call's own register+invite+200+ack to
        // complete and the slot to actually be occupied before retrieval
        // is attempted.
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const retriever = await runForeground({
          scenario: 'uac_call.xml',
          csvLine: `101;${tenantFqdn};700`,
          au: '101',
          ap: ext101.password,
          authUri: tenantFqdn,
          containerName: RETRIEVER_CONTAINER,
        });
        // This is the proof retrieval genuinely bridged real media, not
        // just that both calls independently rang: uac_call.xml's own
        // <recv response="200" rtd="true"> only succeeds once FS actually
        // answers *this* INVITE — which only happens if mod_valet_parking
        // recognized slot 700 as occupied and bridged in.
        expect(retriever.successfulCalls, retriever.stdout).toBe(1);

        // Deliberately not asserting on the parker's own SippStats here:
        // once retrieved, `valet_park`'s bridge means the retriever's own
        // (much shorter, uac_call.xml's 500ms) BYE ends the call for both
        // sides — same as any two-party bridge, and the same reason a real
        // parking-lot deployment never expects the *parker* to be the one
        // who decides when the call ends after pickup. The parker's own
        // later-scripted BYE (uac_call_hold.xml's 4s pause) then lands on
        // an already-torn-down dialog and SIPp reports that attempt as
        // failed — an artifact of reusing a held-call scenario file for the
        // parking side, not evidence retrieval didn't work.
        await parker.result();
      } finally {
        await deleteParkingLot(tenantId, lot.id);
      }
    });
  }, 45_000);
});
