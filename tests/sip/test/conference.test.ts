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
const P1_CONTAINER = 'sip-test-conf-p1';
const P2_CONTAINER = 'sip-test-conf-p2';
const P3_CONTAINER = 'sip-test-conf-p3';
const PIN_CALLER_CONTAINER = 'sip-test-conf-pin-caller';

interface CreatedConferenceRoom {
  readonly id: string;
  readonly number: string;
}

/**
 * S2-20 (G-50, docs/decisions.md): `mod_conference`'s own call shape
 * (`conference.lua`'s bare `session:execute("conference", roomName)`, no
 * explicit profile) gets its first live proof here — issue #39's own
 * literal "Done when": "three SIPp participants join, and a wrong PIN is
 * rejected." `withSingleFsNode` pins every call to one node for the same
 * reason `parking.test.ts` does (G-46): a conference room is a pinned
 * resource, and a second participant round-robining to the node that does
 * not hold the lease would 404 for real.
 */
describe.skipIf(skipReason !== undefined)('S2-15 conference rooms (live SIPp, G-50)', () => {
  let seed: SeedResult;

  beforeAll(async () => {
    seed = await seedFixtures();
  }, 60_000);

  afterEach(async () => {
    await Promise.all(
      [P1_CONTAINER, P2_CONTAINER, P3_CONTAINER, PIN_CALLER_CONTAINER].map((name) =>
        stopContainer(name),
      ),
    );
  });

  async function createRoom(
    tenantId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<CreatedConferenceRoom> {
    const created = await dockerCurlJson(
      'POST',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/conference-rooms`,
      { label: 'S2-20 room', number: '900', maxMembers: 10, ...overrides },
    );
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    return created.json as CreatedConferenceRoom;
  }

  async function deleteRoom(tenantId: string, id: string): Promise<void> {
    await dockerCurlJson(
      'DELETE',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/conference-rooms/${id}`,
    );
  }

  it('three participants dialing the same room all join', async () => {
    await withSingleFsNode(async () => {
      const tenantId = seed.tenantConference.id;
      const tenantFqdn = seed.tenantConference.fqdn;
      const [ext201, ext202, ext203] = ['201', '202', '203'].map((number) => {
        const ext = seed.extensions[`${tenantFqdn}/${number}`];
        if (ext === undefined) throw new Error(`tenantConference/${number} was not seeded`);
        return ext;
      });
      await Promise.all(
        ['201', '202', '203'].map((number) => clearRegistration(`${number}@${tenantFqdn}`)),
      );

      const room = await createRoom(tenantId);
      try {
        // Real-time settling window for pbx.conference_room.created's own
        // event-driven projection into telephony-config's local mirror.
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const p1 = await startDelayedCaller({
          scenario: 'uac_call_hold.xml',
          csvLine: `201;${tenantFqdn};${room.number}`,
          au: '201',
          ap: ext201!.password,
          authUri: tenantFqdn,
          containerName: P1_CONTAINER,
        });
        const p2 = await startDelayedCaller({
          scenario: 'uac_call_hold.xml',
          csvLine: `202;${tenantFqdn};${room.number}`,
          au: '202',
          ap: ext202!.password,
          authUri: tenantFqdn,
          containerName: P2_CONTAINER,
        });
        const p3 = await startDelayedCaller({
          scenario: 'uac_call_hold.xml',
          csvLine: `203;${tenantFqdn};${room.number}`,
          au: '203',
          ap: ext203!.password,
          authUri: tenantFqdn,
          containerName: P3_CONTAINER,
        });

        const [r1, r2, r3] = await Promise.all([p1.result(), p2.result(), p3.result()]);
        expect(r1.successfulCalls, r1.stdout).toBe(1);
        expect(r2.successfulCalls, r2.stdout).toBe(1);
        expect(r3.successfulCalls, r3.stdout).toBe(1);
      } finally {
        await deleteRoom(tenantId, room.id);
      }
    });
  }, 45_000);

  /**
   * G-50's second half of issue #39's own "Done when": a wrong PIN is
   * rejected. `pinRequired` has no dedicated field on the room — setting a
   * `pin` is what implies it (`pbx-config-service`'s own
   * `CreateConferenceRoomBodySchema`/repo derive `pinRequired: pin_enc !==
   * null`), so `createRoom`'s own `pin` override here is both the room's
   * real PIN and the thing that turns PIN checking on. The caller only
   * ever sends the wrong one (`uac_call_wrong_pin.xml`'s own `9999#`,
   * never templated from this room's real PIN) three times, matching
   * `conference.lua`'s own 3-attempt retry loop, and never sends its own
   * BYE — the assertion this test exists to make is that FS-side hangs up
   * unprompted once the loop is exhausted.
   */
  it('rejects a call after three wrong PIN attempts', async () => {
    await withSingleFsNode(async () => {
      const tenantId = seed.tenantConference.id;
      const tenantFqdn = seed.tenantConference.fqdn;
      const ext201 = seed.extensions[`${tenantFqdn}/201`];
      if (ext201 === undefined) throw new Error('tenantConference/201 was not seeded');
      await clearRegistration(`201@${tenantFqdn}`);

      const room = await createRoom(tenantId, { number: '901', pin: '1234' });
      try {
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const result = await runForeground({
          scenario: 'uac_call_wrong_pin.xml',
          csvLine: `201;${tenantFqdn};${room.number}`,
          au: '201',
          ap: ext201.password,
          authUri: tenantFqdn,
          containerName: PIN_CALLER_CONTAINER,
        });
        // Success here means the scenario ran to completion, including its
        // own final `<recv request="BYE">` — i.e. FS genuinely hung up
        // unprompted after the third wrong attempt, not that SIPp's own
        // scripted BYE ended the call the way every other scenario here
        // does.
        expect(result.successfulCalls, result.stdout).toBe(1);
      } finally {
        await deleteRoom(tenantId, room.id);
      }
    });
  }, 45_000);

  /**
   * G-50's own auth mechanism was found, after this file's other two
   * tests were already written and passing, to have been completely
   * broken the whole time (see docs/decisions.md's own detailed account,
   * and G-41's — the same `mod_curl`/`shell_exec` bug `voicemail.lua`
   * shares): `verify-pin`'s Basic auth header could never survive
   * `mod_curl`'s own argument parser intact, so every PIN, right or
   * wrong, was rejected — indistinguishable from the "rejects a call
   * after three wrong PIN attempts" test above, which only ever proves
   * rejection. This test is what that one couldn't be: a genuinely
   * *correct* PIN, sent the same way (real RFC 4733 DTMF, distinct
   * digits — 1/2/3/4 need none of that test's own "never repeat a digit"
   * workaround, since none of them repeat), that actually joins the
   * room rather than getting hung up on.
   */
  it('joins a PIN-required room with the correct PIN', async () => {
    await withSingleFsNode(async () => {
      const tenantId = seed.tenantConference.id;
      const tenantFqdn = seed.tenantConference.fqdn;
      const ext201 = seed.extensions[`${tenantFqdn}/201`];
      if (ext201 === undefined) throw new Error('tenantConference/201 was not seeded');
      await clearRegistration(`201@${tenantFqdn}`);

      const room = await createRoom(tenantId, { number: '902', pin: '1234' });
      try {
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const result = await runForeground({
          scenario: 'uac_call_correct_pin.xml',
          csvLine: `201;${tenantFqdn};${room.number}`,
          au: '201',
          ap: ext201.password,
          authUri: tenantFqdn,
          containerName: PIN_CALLER_CONTAINER,
        });
        // Unlike the wrong-PIN test, this scenario sends its *own* BYE
        // after a real hold — success here means the call stayed up
        // through that hold (`conference.lua` genuinely bridged into the
        // room instead of hanging up), not just that the call didn't
        // error.
        expect(result.successfulCalls, result.stdout).toBe(1);
      } finally {
        await deleteRoom(tenantId, room.id);
      }
    });
  }, 45_000);
});
