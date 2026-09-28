import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  clearRegistration,
  createSignInAdmin,
  dockerCurlJson,
  fsCli,
  fsCliAll,
  internalServiceHeaders,
  runForeground,
  seedFixtures,
  signInThroughGateway,
  sipInfraOrSkipReason,
  startDelayedCaller,
  startUas,
  stopContainer,
  tenantAdminCurlJson,
  tenantAdminHeaders,
  waitForProjected,
  withSingleFsNode,
  type SeedResult,
} from '../src/run-scenario.js';

const skipReason = await sipInfraOrSkipReason();

const GATEWAY_URL = 'http://api-gateway:8080';
const PBX_CONFIG_SERVICE_URL = 'http://pbx-config-service:8080';
const IDENTITY_SERVICE_URL = 'http://identity-service:8080';
const CALL_CONTROL_URL = 'http://call-control:8080';
const CALLER = 'sip-test-calls-801';
const PERSON = 'sip-test-calls-802';
const COLLEAGUE = 'sip-test-calls-803';
const RETRIEVER = 'sip-test-calls-retriever';

interface LiveLeg {
  readonly callUuid: string;
  readonly state: string;
  readonly extension: string | null;
  readonly bridgedTo: string | null;
  readonly parked?: { readonly parkingLotId: string; readonly slot: number } | null;
}

interface AuditEvent {
  readonly action: string;
  readonly resource: string;
  readonly actorId: string;
}

/**
 * S9-12, live: moving calls through api-gateway, as the console and a person's own portal do,
 * against real FreeSWITCH and OpenSIPs. Extension 801 is the caller, 802 the person moving the
 * call (a tenant administrator linked to 802, so it holds both `call.control` and `self.calls`),
 * and 803 a colleague. Every call is pinned to one node (`withSingleFsNode`): call-control acts on
 * the node that holds the call, and a parking lot is a pinned resource.
 *
 * What only a live node proves: that a leg sent back through the dialplan with the tenant's
 * trusted variables really rings the number it is sent to, that an originate into `park()` and
 * then the dialplan makes a click-to-call, that `intercept` of the caller's leg takes a ringing
 * call and stops the other phone, that a park through the dialplan can be retrieved by dialing
 * the slot, and that `uuid_bridge` completes an attended transfer.
 */
describe.skipIf(skipReason !== undefined)('S9-12 moving live calls (live SIPp)', () => {
  let seed: SeedResult;
  let tenantId: string;
  let fqdn: string;
  let token: string;
  /** S9-21: a receptionist, with the built-in role and no phone. */
  let receptionistToken: string;
  let receptionistId: string;
  let userId: string;
  let id802: string;

  beforeAll(async () => {
    seed = await seedFixtures();
    tenantId = seed.tenantCalls.id;
    fqdn = seed.tenantCalls.fqdn;
    const admin = await createSignInAdmin(tenantId, seed.resellerId);
    userId = admin.userId;
    token = await signInThroughGateway(GATEWAY_URL, tenantId, admin.email, admin.password);
    id802 = await extensionId('802');
    const linked = await dockerCurlJson(
      'PATCH',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/extensions/${id802}`,
      { userId },
      await tenantAdminHeaders(tenantId, seed.resellerId),
    );
    expect(linked.status, JSON.stringify(linked.json)).toBe(200);
    const receptionist = await createSignInAdmin(tenantId, seed.resellerId, 'tenant_receptionist');
    receptionistId = receptionist.userId;
    receptionistToken = await signInThroughGateway(
      GATEWAY_URL,
      tenantId,
      receptionist.email,
      receptionist.password,
    );
  }, 120_000);

  afterEach(async () => {
    await Promise.all([CALLER, PERSON, COLLEAGUE, RETRIEVER].map((name) => stopContainer(name)));
  });

  async function extensionId(number: string): Promise<string> {
    const response = await tenantAdminCurlJson(
      seed.resellerId,
      'GET',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${seed.tenantCalls.id}/extensions`,
    );
    const found = (response.json as { rows: { id: string; number: string }[] }).rows.find(
      (row) => row.number === number,
    );
    if (found === undefined) throw new Error(`no seeded extension '${number}'`);
    return found.id;
  }

  function password(number: string): string {
    const entry = seed.extensions[`${fqdn}/${number}`];
    if (entry === undefined) throw new Error(`no seeded extension ${number}`);
    return entry.password;
  }

  /** Through api-gateway, signed in as the console does. */
  function act(path: string, body?: unknown, as = token) {
    return dockerCurlJson('POST', `${GATEWAY_URL}/v1/tenants/${tenantId}/${path}`, body, {
      authorization: `Bearer ${as}`,
    });
  }

  async function legs(): Promise<LiveLeg[]> {
    const response = await dockerCurlJson(
      'GET',
      `${CALL_CONTROL_URL}/internal/v1/tenants/${tenantId}/calls`,
      undefined,
      internalServiceHeaders(),
    );
    return (response.json as { calls?: LiveLeg[] }).calls ?? [];
  }

  /**
   * Whether `leg` is bridged to a leg of extension `ext`. The registry names a pair on one leg,
   * whichever the bridge event did, and a leg that has moved on can still be named by its old
   * partner, so every leg naming it, or named by it, counts.
   */
  function talksTo(leg: LiveLeg, all: LiveLeg[], ext: string): boolean {
    return all.some(
      (other) =>
        other.callUuid !== leg.callUuid &&
        other.extension === ext &&
        (other.callUuid === leg.bridgedTo || other.bridgedTo === leg.callUuid),
    );
  }

  async function waitForLeg(
    what: string,
    match: (leg: LiveLeg, all: LiveLeg[]) => boolean,
  ): Promise<LiveLeg> {
    const deadline = Date.now() + 30_000;
    let last: LiveLeg[] = [];
    while (Date.now() < deadline) {
      last = await legs();
      const found = last.find((leg) => match(leg, last));
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(`${what} never happened: ${JSON.stringify(last)}`);
  }

  async function audited(action: string, actorId = userId): Promise<AuditEvent[]> {
    const deadline = Date.now() + 30_000;
    let found: AuditEvent[] = [];
    while (Date.now() < deadline) {
      const response = await dockerCurlJson(
        'GET',
        `${IDENTITY_SERVICE_URL}/v1/orgs/${tenantId}/audit-events?limit=200`,
        undefined,
        await tenantAdminHeaders(tenantId, seed.resellerId),
      );
      found = (response.json as { rows: AuditEvent[] }).rows.filter(
        (event) => event.action === action && event.actorId === actorId,
      );
      if (found.length > 0) return found;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return found;
  }

  function phone(number: string, container: string, answerScenario?: string) {
    return startUas({
      au: number,
      ap: password(number),
      authUri: fqdn,
      csvLine: `${number};${fqdn}`,
      containerName: container,
      ...(answerScenario === undefined ? {} : { answerScenario }),
    });
  }

  /** 801 calls `to` and stays on until the far end hangs up. */
  function call801(to: string) {
    return startDelayedCaller({
      scenario: 'uac_call_hold_long.xml',
      csvLine: `801;${fqdn};${to}`,
      au: '801',
      ap: password('801'),
      authUri: fqdn,
      containerName: CALLER,
    });
  }

  async function registered(...numbers: string[]) {
    for (const number of numbers) await clearRegistration(`${number}@${fqdn}`);
  }

  it('the console transfers a caller to a colleague: 803 rings and answers, 802 is let go (S9-21: done by a receptionist)', async () => {
    await withSingleFsNode(async () => {
      await registered('801', '802', '803');
      const person = phone('802', PERSON);
      const colleague = phone('803', COLLEAGUE);
      await Promise.all([person.ready(), colleague.ready()]);
      const caller = await call801('802');
      const callerLeg = await waitForLeg(
        '801 talking to 802',
        (leg) => leg.extension === '801' && leg.state === 'answered' && leg.bridgedTo !== null,
      );

      // S9-21: the built-in receptionist role moves calls, and changes no configuration.
      const refused = await dockerCurlJson(
        'POST',
        `${GATEWAY_URL}/v1/tenants/${tenantId}/parking-lots`,
        { label: 'not allowed', slotStart: 790, slotEnd: 791 },
        { authorization: `Bearer ${receptionistToken}` },
      );
      expect(refused.status, JSON.stringify(refused.json)).toBe(403);
      const moved = await act(
        `calls/${callerLeg.callUuid}/transfer`,
        { to: '803' },
        receptionistToken,
      );
      expect(moved.status, JSON.stringify(moved.json)).toBe(200);
      expect(moved.json).toEqual({ result: 'transferred', callUuid: callerLeg.callUuid });

      const withColleague = await waitForLeg(
        '801 talking to 803',
        (leg, all) => leg.callUuid === callerLeg.callUuid && talksTo(leg, all, '803'),
      );
      expect(withColleague.state).toBe('answered');
      expect((await person.result()).successfulCalls).toBe(1);

      await fsCli(`uuid_kill ${callerLeg.callUuid}`);
      expect((await colleague.result()).successfulCalls).toBe(1);
      await caller.result();
      expect(await audited('call.transfer', receptionistId)).toContainEqual(
        expect.objectContaining({ resource: `call:${callerLeg.callUuid}` }),
      );
    });
  }, 120_000);

  it('click-to-call: 802’s own phone rings first, then 803 is dialed from it', async () => {
    await withSingleFsNode(async () => {
      await registered('802', '803');
      const person = phone('802', PERSON);
      const colleague = phone('803', COLLEAGUE);
      await Promise.all([person.ready(), colleague.ready()]);

      const dialed = await act('me/dial', { to: '803' });
      expect(dialed.status, JSON.stringify(dialed.json)).toBe(200);
      const { callUuid } = dialed.json as { callUuid: string };

      await waitForLeg(
        '802 talking to 803',
        (leg, all) => leg.callUuid === callUuid && talksTo(leg, all, '803'),
      );
      // The colleague sees the call as from 802, the person's own extension. A call that starts
      // at the person's phone may start on either node (`withSingleFsNode` pins only OpenSIPs).
      expect(await fsCliAll(`uuid_getvar ${callUuid} sip_from_user`)).toContain('802');

      await fsCliAll(`uuid_kill ${callUuid}`);
      expect((await person.result()).successfulCalls).toBe(1);
      expect((await colleague.result()).successfulCalls).toBe(1);
      expect(await audited('call.dial')).not.toEqual([]);
    });
  }, 120_000);

  it('802 parks its caller; dialing the slot takes the call back', async () => {
    await withSingleFsNode(async () => {
      const lot = await tenantAdminCurlJson(
        seed.resellerId,
        'POST',
        `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/parking-lots`,
        { label: 'S9-12 lot', slotStart: 750, slotEnd: 759, timeoutSeconds: 120 },
      );
      expect(lot.status, JSON.stringify(lot.json)).toBe(201);
      const lotId = (lot.json as { id: string }).id;
      try {
        await waitForProjected('parking_lots', 'id', lotId);
        await registered('801', '802', '803');
        const person = phone('802', PERSON);
        await person.ready();
        const caller = await call801('802');
        const ownLeg = await waitForLeg(
          '802 answering 801',
          (leg) => leg.extension === '802' && leg.state === 'answered',
        );

        const parked = await act(`me/live-calls/${ownLeg.callUuid}/park`, { parkingLotId: lotId });
        expect(parked.status, JSON.stringify(parked.json)).toBe(200);
        expect(parked.json).toEqual({ result: 'parked', parkingLotId: lotId, slot: 750 });
        expect((await person.result()).successfulCalls).toBe(1);
        // S9-14: the live calls say where the caller waits (mod_valet_parking's own event).
        await waitForLeg(
          '801 shown parked in slot 750',
          (leg) => leg.parked?.parkingLotId === lotId && leg.parked.slot === 750,
        );

        const retriever = await runForeground({
          scenario: 'uac_call.xml',
          csvLine: `803;${fqdn};750`,
          au: '803',
          ap: password('803'),
          authUri: fqdn,
          containerName: RETRIEVER,
        });
        // Only answered if the slot held 801's call (`parking.test.ts` explains why).
        expect(retriever.successfulCalls, retriever.stdout).toBe(1);
        // Taken back: no longer parked.
        expect((await legs()).some((leg) => leg.parked != null)).toBe(false);
        await caller.result();
      } finally {
        await tenantAdminCurlJson(
          seed.resellerId,
          'DELETE',
          `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/parking-lots/${lotId}`,
        );
      }
    });
  }, 120_000);

  it('the console picks up a call ringing 803 on 802’s phone: 803 stops ringing', async () => {
    await withSingleFsNode(async () => {
      await registered('801', '802', '803');
      const person = phone('802', PERSON);
      const colleague = phone('803', COLLEAGUE, 'ring_until_cancelled.xml');
      await Promise.all([person.ready(), colleague.ready()]);
      const caller = await call801('803');
      const ringing = await waitForLeg(
        '803 ringing',
        (leg) => leg.extension === '803' && leg.state === 'ringing',
      );

      const picked = await act(`calls/${ringing.callUuid}/pickup`);
      expect(picked.status, JSON.stringify(picked.json)).toBe(200);
      const { callUuid } = picked.json as { callUuid: string };

      // 803 was cancelled, and 802 is talking to the caller.
      expect((await colleague.result()).successfulCalls).toBe(1);
      const withPerson = await waitForLeg(
        '802 talking to 801',
        (leg, all) => leg.callUuid === callUuid && talksTo(leg, all, '801'),
      );
      expect(withPerson.state).toBe('answered');

      await fsCli(`uuid_kill ${callUuid}`);
      expect((await person.result()).successfulCalls).toBe(1);
      await caller.result();
      expect(await audited('call.pickup')).not.toEqual([]);
    });
  }, 120_000);

  it('an attended transfer: 801 waits while 802 talks to 803, then 801 and 803 are joined', async () => {
    await withSingleFsNode(async () => {
      await registered('801', '802', '803');
      const person = phone('802', PERSON);
      const colleague = phone('803', COLLEAGUE);
      await Promise.all([person.ready(), colleague.ready()]);
      const caller = await call801('802');
      // Only the caller's leg names the other in the registry.
      const callerSide = await waitForLeg('801 talking to 802', (leg, all) => {
        return leg.extension === '801' && talksTo(leg, all, '802') && leg.bridgedTo !== null;
      });
      const callerLeg = callerSide.callUuid;
      const ownLeg = { callUuid: callerSide.bridgedTo! };

      const consult = await act(`me/live-calls/${ownLeg.callUuid}/transfer`, {
        to: '803',
        attended: true,
      });
      expect(consult.status, JSON.stringify(consult.json)).toBe(200);
      expect(consult.json).toEqual({ result: 'consulting', heldCallUuid: callerLeg });

      // 802 (the same leg, the same phone call) is now talking to 803.
      await waitForLeg(
        '802 talking to 803',
        (leg, all) => leg.callUuid === ownLeg.callUuid && talksTo(leg, all, '803'),
      );

      // S9-19: 801 hears the tenant's hold music (this tenant has none: the neutral tone), and a
      // ring-back to 802 is scheduled on the node for five minutes from now.
      expect(await fsCliAll(`uuid_getvar ${callerLeg} hold_music`)).toContain('tone_stream://');
      expect(await fsCliAll('show tasks')).toContain(`cuc-ringback-${callerLeg}`);

      const done = await act(`me/live-calls/${ownLeg.callUuid}/transfer/complete`);
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      const joined = await waitForLeg(
        '801 talking to 803',
        (leg, all) => leg.callUuid === callerLeg && talksTo(leg, all, '803'),
      );
      expect(joined.state).toBe('answered');
      expect((await person.result()).successfulCalls).toBe(1);
      // Joined: the ring-back is gone (the scheduler drops a deleted task on its next tick).
      await expect
        .poll(() => fsCliAll('show tasks'), { timeout: 5_000 })
        .not.toContain(`cuc-ringback-${callerLeg}`);
      expect((await person.result()).successfulCalls).toBe(1);

      await fsCli(`uuid_kill ${callerLeg}`);
      expect((await colleague.result()).successfulCalls).toBe(1);
      await caller.result();
      expect(await audited('call.transfer.complete')).not.toEqual([]);
    });
  }, 120_000);

  /** S9-18: a pickup group of 802 and 803; removed afterwards. */
  async function withPickupGroup(run: () => Promise<void>): Promise<void> {
    const created = await dockerCurlJson(
      'POST',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/pickup-groups`,
      { label: 'S9-18 front desk', memberExtensionIds: [id802, await extensionId('803')] },
      await tenantAdminHeaders(tenantId, seed.resellerId),
    );
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    try {
      await run();
    } finally {
      await dockerCurlJson(
        'DELETE',
        `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/pickup-groups/${(created.json as { id: string }).id}`,
        undefined,
        await tenantAdminHeaders(tenantId, seed.resellerId),
      );
    }
  }

  it('S9-18: 802 sees the call ringing 803, its pickup group, and takes it from the portal', async () => {
    await withSingleFsNode(async () => {
      await withPickupGroup(async () => {
        await registered('801', '802', '803');
        const person = phone('802', PERSON);
        const colleague = phone('803', COLLEAGUE, 'ring_until_cancelled.xml');
        await Promise.all([person.ready(), colleague.ready()]);
        const caller = await call801('803');
        const ringing = await waitForLeg(
          '803 ringing',
          (leg) => leg.extension === '803' && leg.state === 'ringing',
        );

        const offered = await dockerCurlJson(
          'GET',
          `${GATEWAY_URL}/v1/tenants/${tenantId}/me/pickup`,
          undefined,
          { authorization: `Bearer ${token}` },
        );
        expect(offered.status, JSON.stringify(offered.json)).toBe(200);
        expect(offered.json).toMatchObject({
          calls: [{ callUuid: ringing.callUuid, extension: '803' }],
        });

        const picked = await act('me/pickup', {});
        expect(picked.status, JSON.stringify(picked.json)).toBe(200);
        expect((await colleague.result()).successfulCalls).toBe(1);
        const { callUuid } = picked.json as { callUuid: string };
        await waitForLeg(
          '802 talking to 801',
          (leg, all) => leg.callUuid === callUuid && talksTo(leg, all, '801'),
        );
        await fsCliAll(`uuid_kill ${callUuid}`);
        expect((await person.result()).successfulCalls).toBe(1);
        await caller.result();
      });
    });
  }, 120_000);

  it('S9-18: 802 dials *8 and answers the call ringing 803', async () => {
    await withSingleFsNode(async () => {
      await withPickupGroup(async () => {
        await registered('801', '802', '803');
        const colleague = phone('803', COLLEAGUE, 'ring_until_cancelled.xml');
        await colleague.ready();
        const caller = await call801('803');
        await waitForLeg(
          '803 ringing',
          (leg) => leg.extension === '803' && leg.state === 'ringing',
        );

        // uac_call.xml succeeds only if FreeSWITCH answers the *8 call: the intercept joined it.
        const picker = await runForeground({
          scenario: 'uac_call.xml',
          csvLine: `802;${fqdn};*8`,
          au: '802',
          ap: password('802'),
          authUri: fqdn,
          containerName: RETRIEVER,
        });
        expect(picker.successfulCalls, picker.stdout).toBe(1);
        expect((await colleague.result()).successfulCalls).toBe(1);
        await caller.result();
      });
    });
  }, 120_000);
});
