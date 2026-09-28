import type { AuditEventInput } from '@cuc/audit';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';
import {
  redisOrSkipReason,
  silentLogger,
  startTestRedis,
  type TestRedisHandle,
} from '@cuc/testing';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createCallOperations, occupiedSlots, type OperationsEsl } from '../src/call-operations.js';
import type { ParkingLotSlots } from '../src/clients.js';
import type { EslApiResult } from '../src/esl/client.js';
import { createCallRegistry, type CallRegistry } from '../src/redis/registry.js';
import {
  registerCallOperationRoutes,
  registerPickupInternalRoutes,
} from '../src/routes/call-operations.routes.js';

const skipReason = await redisOrSkipReason();
const SECRET = 'test-internal-header-secret';
const DOMAIN = 'acme.platform.test';

/** What happened, in order, so a test can see the audit came before the node was told anything. */
type Step = { kind: 'audit'; input: AuditEventInput } | { kind: 'esl'; command: string };

/** A media node: channel variables, the parking lots' occupied slots, and every command. */
class FakeNode implements OperationsEsl {
  readonly vars = new Map<string, Map<string, string>>();
  /** `valet_info` per lot name. */
  readonly lots = new Map<string, number[]>();
  /** What the next `originate` job ends with. */
  originateResult = '+OK\n';
  /** Channels that have gone: commands on them answer as FreeSWITCH does. */
  readonly gone = new Set<string>();

  constructor(private readonly steps: Step[]) {}

  sendApi(command: string): Promise<EslApiResult> {
    this.steps.push({ kind: 'esl', command });
    const [verb, uuid = '', name = ''] = command.split(' ');
    if (this.gone.has(uuid)) return Promise.resolve({ ok: false, body: '-ERR No such channel!' });
    if (verb === 'uuid_getvar') {
      return Promise.resolve({ ok: true, body: this.vars.get(uuid)?.get(name) ?? '_undef_' });
    }
    if (verb === 'valet_info') {
      const slots = this.lots.get(uuid) ?? [];
      return Promise.resolve({
        ok: true,
        body: `<lots><lot name="${uuid}">${slots
          .map((slot) => `<extension uuid="x">${String(slot)}</extension>`)
          .join('')}</lot></lots>`,
      });
    }
    return Promise.resolve({ ok: true, body: '+OK' });
  }

  sendBgApi(command: string): Promise<EslApiResult> {
    this.steps.push({ kind: 'esl', command: `bgapi ${command}` });
    const body = this.originateResult;
    return Promise.resolve({ ok: !body.startsWith('-ERR'), body });
  }
}

describe('occupiedSlots', () => {
  it('reads the slots valet_info lists', () => {
    expect([
      ...occupiedSlots(
        '<lots><lot name="l@d"><extension uuid="a">701</extension><extension uuid="b"> 703 </extension></lot></lots>',
      ),
    ]).toEqual([701, 703]);
    expect(occupiedSlots('')).toEqual(new Set());
  });
});

describe.skipIf(skipReason !== undefined)(
  'moving live calls (S9-12): hang up, transfer, park, pick up, click-to-call',
  () => {
    let redisHandle: TestRedisHandle;
    let redis: Redis;
    let registry: CallRegistry;
    let app: Server;
    let node: FakeNode;
    const steps: Step[] = [];
    /** Permissions held, by user id. */
    const held = new Map<string, string[]>();
    /** Own extension numbers, by user id. */
    const numbers = new Map<string, string>();
    const lots = new Map<string, ParkingLotSlots>();
    /** Parking lot leases, by lot id. */
    const leases = new Map<string, string>();
    let auditDown = false;
    /** S9-18: each extension's pickup peers (pbx-config-service's answer), by number. */
    const peers = new Map<string, string[]>();

    beforeAll(async () => {
      redisHandle = await startTestRedis();
      redis = new Redis(redisHandle.url);
      registry = createCallRegistry(redis, redisHandle.keyPrefix);
      app = await createServer({
        serviceName: 'call-control-test',
        logger: silentLogger(),
        context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
        permissions: (actor, permission) =>
          Promise.resolve(held.get(actor.id)?.includes(permission) ?? false),
      });
      const operations = createCallOperations({
        registry,
        esl: (nodeId) => (nodeId === 'fs-1' ? node : undefined),
        anyNode: () => Promise.resolve('fs-1'),
        userExtension: (_tenantId, userId) => {
          const number = numbers.get(userId);
          return Promise.resolve(
            number === undefined ? undefined : { extensionId: `EXT-${number}`, number },
          );
        },
        tenantDomain: () => Promise.resolve(DOMAIN),
        parkingLot: (_tenantId, lotId) => Promise.resolve(lots.get(lotId)),
        parkingLotNode: (_tenantId, lotId) => Promise.resolve(leases.get(lotId)),
        pickupPeers: (_tenantId, number) => Promise.resolve(peers.get(number) ?? []),
        audit: (input) => {
          if (auditDown) return Promise.reject(new Error('database down'));
          steps.push({ kind: 'audit', input });
          return Promise.resolve();
        },
        opensipsSipUri: 'opensips:5060',
        ringTimeoutSeconds: 30,
        logger: silentLogger(),
      });
      registerCallOperationRoutes(app, { operations });
      registerPickupInternalRoutes(app, { operations, internalServiceToken: 'internal-token' });
      await app.ready();
    });

    afterAll(async () => {
      await app?.close();
      redis?.disconnect();
      await redisHandle?.stop();
    });

    afterEach(() => {
      steps.length = 0;
      held.clear();
      numbers.clear();
      lots.clear();
      leases.clear();
      peers.clear();
      auditDown = false;
    });

    /** A caller answered by extension `ext` on fs-1: two legs, bridged. */
    async function liveCall(
      tenantId: string,
      options: { ext?: string; state?: 'answered' | 'ringing'; bridged?: boolean } = {},
    ) {
      node = new FakeNode(steps);
      const caller = crypto.randomUUID();
      const phone = crypto.randomUUID();
      const ext = options.ext ?? '301';
      const leg = (callUuid: string, direction: 'inbound' | 'outbound', extension: string | null) =>
        registry.createCall(
          {
            callUuid,
            nodeId: 'fs-1',
            tenantId,
            direction,
            state: callUuid === caller ? 'answered' : (options.state ?? 'answered'),
            startedAt: String(Date.now()),
            from: '+15550100',
            to: ext,
            extension,
            controls: 'none',
          },
          60_000,
        );
      await leg(caller, 'inbound', null);
      await leg(phone, 'outbound', ext);
      if (options.bridged !== false) {
        // As the live registry has it: only the caller's leg names the other (the bridge event's).
        await registry.updateCall(caller, { bridgedTo: phone });
      }
      node.vars.set(phone, new Map([['originating_leg_uuid', caller]]));
      return { caller, phone };
    }

    function person(
      tenantId: string,
      permissions: string[],
      options: { number?: string; orgType?: 'tenant' | 'reseller' } = {},
    ) {
      const userId = crypto.randomUUID();
      held.set(userId, permissions);
      numbers.set(userId, options.number ?? '201');
      const orgType = options.orgType ?? 'tenant';
      return {
        userId,
        headers: signInternalHeaders(SECRET, {
          actorId: userId,
          actorType: 'user',
          orgId: tenantId,
          orgType,
          ...(orgType === 'tenant' ? { tenantId } : {}),
        }),
      };
    }

    const post = (url: string, headers: Record<string, string>, body?: object) =>
      app.inject({
        method: 'POST',
        url,
        headers,
        ...(body === undefined ? {} : { payload: body }),
      });
    const commands = () =>
      steps.flatMap((step) => (step.kind === 'esl' ? [step.command] : ['<audit>']));
    const audits = () => steps.flatMap((step) => (step.kind === 'audit' ? [step.input] : []));

    it('declares every route private: call.control across the tenant, self.calls for a person', () => {
      const routes = [
        ['calls/:callUuid/hangup', 'call.control'],
        ['calls/:callUuid/transfer', 'call.control'],
        ['calls/:callUuid/park', 'call.control'],
        ['calls/:callUuid/pickup', 'call.control'],
        ['me/live-calls/:callUuid/hangup', 'self.calls'],
        ['me/live-calls/:callUuid/transfer', 'self.calls'],
        ['me/live-calls/:callUuid/transfer/complete', 'self.calls'],
        ['me/live-calls/:callUuid/transfer/cancel', 'self.calls'],
        ['me/live-calls/:callUuid/park', 'self.calls'],
        ['me/dial', 'self.calls'],
      ];
      for (const [path, permission] of routes) {
        expect(app.registeredRoutes).toContainEqual(
          expect.objectContaining({
            method: 'POST',
            url: `/v1/tenants/:tenantId/${path!}`,
            permission,
            dataClass: 'private',
          }),
        );
      }
    });

    describe('from the console (call.control)', () => {
      it('hangs up: audits first, then kills the leg', async () => {
        const tenantId = crypto.randomUUID();
        const { caller } = await liveCall(tenantId);
        const { headers, userId } = person(tenantId, ['call.control']);
        const response = await post(`/v1/tenants/${tenantId}/calls/${caller}/hangup`, headers);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ result: 'hungup' });
        expect(commands()).toEqual(['<audit>', `uuid_kill ${caller} NORMAL_CLEARING`]);
        expect(audits()[0]).toMatchObject({
          action: 'call.hangup',
          actorId: userId,
          resource: `call:${caller}`,
          dataClass: 'private',
        });
      });

      it('transfers the caller through the tenant’s own dialplan, as its internal call, keeping the caller ID', async () => {
        const tenantId = crypto.randomUUID();
        const { caller } = await liveCall(tenantId);
        const { headers } = person(tenantId, ['call.control']);
        const response = await post(`/v1/tenants/${tenantId}/calls/${caller}/transfer`, headers, {
          to: '102',
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ result: 'transferred', callUuid: caller });
        expect(commands()).toEqual([
          '<audit>',
          `uuid_setvar_multi ${caller} sip_h_X-Call-Direction=internal;sip_h_X-Tenant-Id=${tenantId}`,
          `uuid_transfer ${caller} 102 XML public`,
        ]);
        expect(audits()[0]).toMatchObject({ action: 'call.transfer', reason: 'to 102' });
      });

      it('refuses what cannot be dialed before anything is done', async () => {
        const tenantId = crypto.randomUUID();
        const { caller } = await liveCall(tenantId);
        const { headers } = person(tenantId, ['call.control']);
        for (const to of ['abc', '1 2', '102;uuid_kill x', '', '+'.repeat(3)]) {
          const response = await post(`/v1/tenants/${tenantId}/calls/${caller}/transfer`, headers, {
            to,
          });
          expect(response.statusCode, to).toBe(400);
        }
        expect(steps).toEqual([]);
      });

      it('parks in the first free slot, and never two calls in one', async () => {
        const tenantId = crypto.randomUUID();
        const first = await liveCall(tenantId);
        const firstNode = node;
        lots.set('lot-1', { id: 'lot-1', slotStart: 700, slotEnd: 702 });
        firstNode.lots.set(`lot-1@${DOMAIN}`, [700]);
        const { headers } = person(tenantId, ['call.control']);

        const parked = await post(`/v1/tenants/${tenantId}/calls/${first.caller}/park`, headers, {
          parkingLotId: 'lot-1',
        });
        expect(parked.statusCode).toBe(200);
        expect(parked.json()).toEqual({ result: 'parked', parkingLotId: 'lot-1', slot: 701 });
        expect(commands()).toContain(`uuid_transfer ${first.caller} 701 XML public`);
        expect(audits()[0]).toMatchObject({ action: 'call.park', reason: 'lot lot-1 slot 701' });

        // The node has not listed 701 yet: the reservation still keeps the next call out of it.
        const second = await liveCall(tenantId);
        node.lots.set(`lot-1@${DOMAIN}`, [700]);
        const next = await post(`/v1/tenants/${tenantId}/calls/${second.caller}/park`, headers, {
          parkingLotId: 'lot-1',
        });
        expect(next.json()).toMatchObject({ slot: 702 });

        const third = await liveCall(tenantId);
        node.lots.set(`lot-1@${DOMAIN}`, [700, 701, 702]);
        const full = await post(`/v1/tenants/${tenantId}/calls/${third.caller}/park`, headers, {
          parkingLotId: 'lot-1',
        });
        expect(full.statusCode).toBe(409);
        expect(full.json()).toMatchObject({ code: 'parking_lot_full' });
      });

      it('an unknown lot, and a lot whose calls are on another node, are refused with nothing done', async () => {
        const tenantId = crypto.randomUUID();
        const { caller } = await liveCall(tenantId);
        const { headers } = person(tenantId, ['call.control']);
        const unknown = await post(`/v1/tenants/${tenantId}/calls/${caller}/park`, headers, {
          parkingLotId: 'nope',
        });
        expect(unknown.statusCode).toBe(404);
        expect(unknown.json()).toMatchObject({ code: 'parking_lot_not_found' });

        lots.set('lot-2', { id: 'lot-2', slotStart: 800, slotEnd: 801 });
        leases.set('lot-2', 'fs-9');
        const elsewhere = await post(`/v1/tenants/${tenantId}/calls/${caller}/park`, headers, {
          parkingLotId: 'lot-2',
        });
        expect(elsewhere.statusCode).toBe(409);
        expect(elsewhere.json()).toMatchObject({ code: 'parking_lot_elsewhere' });
        expect(steps).toEqual([]);
      });

      it('picks up a call ringing someone else: rings their own phone into intercept of the caller', async () => {
        const tenantId = crypto.randomUUID();
        const { caller, phone } = await liveCall(tenantId, {
          ext: '102',
          state: 'ringing',
          bridged: false,
        });
        const { headers } = person(tenantId, ['call.control'], { number: '201' });
        const response = await post(`/v1/tenants/${tenantId}/calls/${phone}/pickup`, headers);
        expect(response.statusCode).toBe(200);
        const { callUuid } = response.json<{ callUuid: string }>();
        const originate = commands().find((command) => command.startsWith('bgapi originate'))!;
        expect(originate).toContain(`origination_uuid=${callUuid}`);
        expect(originate).toContain('sip_route_uri=sip:opensips:5060');
        expect(originate).toContain('origination_caller_id_number=+15550100');
        expect(originate).toContain(`}sofia/internal/201@${DOMAIN} &intercept(${caller})`);
        expect(commands().indexOf('<audit>')).toBeLessThan(
          commands().indexOf(`bgapi ${originate.slice(6)}`),
        );
        expect(audits()[0]).toMatchObject({ action: 'call.pickup', resource: `call:${caller}` });
      });

      it('does not pick up an answered call, or one ringing their own phone', async () => {
        const tenantId = crypto.randomUUID();
        const answered = await liveCall(tenantId, { ext: '102' });
        const { headers } = person(tenantId, ['call.control'], { number: '201' });
        const notRinging = await post(
          `/v1/tenants/${tenantId}/calls/${answered.phone}/pickup`,
          headers,
        );
        expect(notRinging.json()).toMatchObject({ code: 'call_not_ringing' });

        const mine = await liveCall(tenantId, { ext: '201', state: 'ringing', bridged: false });
        const own = await post(`/v1/tenants/${tenantId}/calls/${mine.phone}/pickup`, headers);
        expect(own.json()).toMatchObject({ code: 'own_call' });
        expect(steps).toEqual([]);
      });

      it('another tenant’s call is no such call; without call.control, a reseller or no audit, nothing is done', async () => {
        const tenantId = crypto.randomUUID();
        const other = crypto.randomUUID();
        const { caller } = await liveCall(other);
        const admin = person(tenantId, ['call.control']);
        const foreign = await post(`/v1/tenants/${tenantId}/calls/${caller}/hangup`, admin.headers);
        expect(foreign.statusCode).toBe(404);
        expect(foreign.json()).toMatchObject({ code: 'call_not_found' });

        const mineCall = await liveCall(tenantId);
        const user = person(tenantId, ['self.calls']);
        const refused = await post(
          `/v1/tenants/${tenantId}/calls/${mineCall.caller}/hangup`,
          user.headers,
        );
        expect(refused.statusCode).toBe(403);

        const reseller = person(tenantId, ['call.control'], { orgType: 'reseller' });
        const h1 = await post(
          `/v1/tenants/${tenantId}/calls/${mineCall.caller}/hangup`,
          reseller.headers,
        );
        expect(h1.statusCode).toBe(403);

        auditDown = true;
        const down = await post(
          `/v1/tenants/${tenantId}/calls/${mineCall.caller}/hangup`,
          admin.headers,
        );
        expect(down.statusCode).toBe(503);
        expect(down.json()).toMatchObject({ code: 'call_control_unavailable' });
        expect(steps).toEqual([]);
      });
    });

    describe('a person, on their own calls (self.calls)', () => {
      it('transfers the other party, and only on a call of their own extension', async () => {
        const tenantId = crypto.randomUUID();
        const { caller, phone } = await liveCall(tenantId, { ext: '201' });
        const { headers } = person(tenantId, ['self.calls'], { number: '201' });
        const response = await post(
          `/v1/tenants/${tenantId}/me/live-calls/${phone}/transfer`,
          headers,
          { to: '+14155550142' },
        );
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ result: 'transferred', callUuid: caller });
        expect(commands()).toContain(`uuid_transfer ${caller} +14155550142 XML public`);

        const someoneElse = person(tenantId, ['self.calls'], { number: '202' });
        steps.length = 0;
        const notMine = await post(
          `/v1/tenants/${tenantId}/me/live-calls/${phone}/transfer`,
          someoneElse.headers,
          { to: '102' },
        );
        expect(notMine.statusCode).toBe(404);
        expect(steps).toEqual([]);
      });

      it('a call not connected yet cannot be transferred, nor sent to their own number', async () => {
        const tenantId = crypto.randomUUID();
        const lone = await liveCall(tenantId, { ext: '201', bridged: false });
        const { headers } = person(tenantId, ['self.calls'], { number: '201' });
        const unconnected = await post(
          `/v1/tenants/${tenantId}/me/live-calls/${lone.phone}/transfer`,
          headers,
          { to: '102' },
        );
        expect(unconnected.json()).toMatchObject({ code: 'call_not_connected' });

        const call = await liveCall(tenantId, { ext: '201' });
        const self = await post(
          `/v1/tenants/${tenantId}/me/live-calls/${call.phone}/transfer`,
          headers,
          { to: '201' },
        );
        expect(self.json()).toMatchObject({ code: 'own_call' });
      });

      it('hangs up and parks their own call', async () => {
        const tenantId = crypto.randomUUID();
        const { caller, phone } = await liveCall(tenantId, { ext: '201' });
        lots.set('lot-1', { id: 'lot-1', slotStart: 700, slotEnd: 709 });
        const { headers } = person(tenantId, ['self.calls'], { number: '201' });
        const parked = await post(`/v1/tenants/${tenantId}/me/live-calls/${phone}/park`, headers, {
          parkingLotId: 'lot-1',
        });
        expect(parked.json()).toMatchObject({ result: 'parked', slot: 700 });
        // The other party is parked, not the person.
        expect(commands()).toContain(`uuid_transfer ${caller} 700 XML public`);

        const again = await liveCall(tenantId, { ext: '201' });
        const hungUp = await post(
          `/v1/tenants/${tenantId}/me/live-calls/${again.phone}/hangup`,
          headers,
        );
        expect(hungUp.json()).toEqual({ result: 'hungup' });
        expect(commands()).toContain(`uuid_kill ${again.phone} NORMAL_CLEARING`);
      });

      it('an attended transfer: the caller waits, the person talks to the colleague, then joins them', async () => {
        const tenantId = crypto.randomUUID();
        const { caller, phone } = await liveCall(tenantId, { ext: '201' });
        const { headers } = person(tenantId, ['self.calls'], { number: '201' });
        const consult = await post(
          `/v1/tenants/${tenantId}/me/live-calls/${phone}/transfer`,
          headers,
          { to: '102', attended: true },
        );
        expect(consult.statusCode).toBe(200);
        expect(consult.json()).toEqual({ result: 'consulting', heldCallUuid: caller });
        expect(commands()).toEqual([
          '<audit>',
          `uuid_setvar ${phone} park_after_bridge true`,
          // S9-19: the caller hears hold music (a tone when the call has none), and after five
          // minutes rings 201 again instead of being dropped.
          `uuid_getvar ${caller} hold_music`,
          `uuid_setvar ${caller} hold_music tone_stream://%(250,4750,440);loops=-1`,
          `uuid_setvar_multi ${caller} sip_h_X-Call-Direction=internal;sip_h_X-Tenant-Id=${tenantId}`,
          `uuid_transfer ${caller} endless_playback:\${hold_music} inline`,
          `sched_api +300 cuc-ringback-${caller} uuid_transfer ${caller} 201 XML public`,
          `uuid_setvar_multi ${phone} sip_h_X-Call-Direction=internal;sip_h_X-Tenant-Id=${tenantId};sip_from_user=201;effective_caller_id_number=201;effective_caller_id_name=201`,
          `uuid_transfer ${phone} 102 XML public`,
        ]);
        expect(audits()[0]).toMatchObject({ action: 'call.transfer.consult', reason: 'to 102' });

        // A second transfer on top of the first is refused.
        const twice = await post(
          `/v1/tenants/${tenantId}/me/live-calls/${phone}/transfer`,
          headers,
          { to: '103', attended: true },
        );
        expect(twice.json()).toMatchObject({ code: 'transfer_in_progress' });

        // Not answered yet: the person is still bridged to nobody new.
        await registry.updateCall(phone, { bridgedTo: caller });
        const early = await post(
          `/v1/tenants/${tenantId}/me/live-calls/${phone}/transfer/complete`,
          headers,
        );
        expect(early.json()).toMatchObject({ code: 'consult_not_answered' });

        // 102 answers.
        const colleague = crypto.randomUUID();
        await registry.createCall(
          {
            callUuid: colleague,
            nodeId: 'fs-1',
            tenantId,
            direction: 'outbound',
            state: 'answered',
            startedAt: String(Date.now()),
            from: '201',
            to: '102',
            extension: '102',
            controls: 'none',
          },
          60_000,
        );
        await registry.updateCall(phone, { bridgedTo: colleague });
        steps.length = 0;
        const done = await post(
          `/v1/tenants/${tenantId}/me/live-calls/${phone}/transfer/complete`,
          headers,
        );
        expect(done.json()).toEqual({ result: 'transferred' });
        expect(commands()).toEqual([
          '<audit>',
          `uuid_bridge ${caller} ${colleague}`,
          `sched_del cuc-ringback-${caller}`,
          `uuid_kill ${phone} NORMAL_CLEARING`,
        ]);
      });

      it('or goes back to the caller', async () => {
        const tenantId = crypto.randomUUID();
        const { caller, phone } = await liveCall(tenantId, { ext: '201' });
        const { headers } = person(tenantId, ['self.calls'], { number: '201' });
        const none = await post(
          `/v1/tenants/${tenantId}/me/live-calls/${phone}/transfer/cancel`,
          headers,
        );
        expect(none.json()).toMatchObject({ code: 'no_transfer_in_progress' });

        await post(`/v1/tenants/${tenantId}/me/live-calls/${phone}/transfer`, headers, {
          to: '102',
          attended: true,
        });
        steps.length = 0;
        const back = await post(
          `/v1/tenants/${tenantId}/me/live-calls/${phone}/transfer/cancel`,
          headers,
        );
        expect(back.json()).toEqual({ result: 'resumed' });
        expect(commands()).toEqual([
          '<audit>',
          `uuid_bridge ${phone} ${caller}`,
          `sched_del cuc-ringback-${caller}`,
          `uuid_setvar ${phone} park_after_bridge false`,
        ]);
        expect((await registry.getCall(phone))?.['consultHeld']).toBe('');
      });

      it('S9-18: lists the calls ringing in their pickup groups, and picks up the oldest on their own phone', async () => {
        const tenantId = crypto.randomUUID();
        peers.set('201', ['102', '103']);
        const first = await liveCall(tenantId, { ext: '102', state: 'ringing', bridged: false });
        await new Promise((resolve) => setTimeout(resolve, 5));
        const second = await liveCall(tenantId, { ext: '103', state: 'ringing', bridged: false });
        // Outside their groups, and their own: never offered.
        await liveCall(tenantId, { ext: '104', state: 'ringing', bridged: false });
        await liveCall(tenantId, { ext: '201', state: 'ringing', bridged: false });
        node.vars.set(first.phone, new Map([['originating_leg_uuid', first.caller]]));
        node.vars.set(second.phone, new Map([['originating_leg_uuid', second.caller]]));
        const { headers } = person(tenantId, ['self.calls'], { number: '201' });

        const list = await app.inject({
          method: 'GET',
          url: `/v1/tenants/${tenantId}/me/pickup`,
          headers,
        });
        expect(list.statusCode).toBe(200);
        expect(
          list
            .json<{ calls: { callUuid: string; extension: string }[] }>()
            .calls.map((c) => c.extension),
        ).toEqual(['102', '103']);

        const picked = await post(`/v1/tenants/${tenantId}/me/pickup`, headers, {});
        expect(picked.statusCode).toBe(200);
        expect(commands().find((c) => c.startsWith('bgapi originate'))).toContain(
          `&intercept(${first.caller})`,
        );
        expect(audits()[0]).toMatchObject({ action: 'call.pickup' });

        // A call named that is not in their groups is no call of theirs.
        const outside = await liveCall(tenantId, { ext: '104', state: 'ringing', bridged: false });
        const refused = await post(`/v1/tenants/${tenantId}/me/pickup`, headers, {
          callUuid: outside.phone,
        });
        expect(refused.statusCode).toBe(404);
        expect(refused.json()).toMatchObject({ code: 'call_not_found' });
      });

      it('S9-18: nothing ringing in their groups is said', async () => {
        const tenantId = crypto.randomUUID();
        node = new FakeNode(steps);
        const { headers } = person(tenantId, ['self.calls'], { number: '201' });
        const none = await post(`/v1/tenants/${tenantId}/me/pickup`, headers, {});
        expect(none.statusCode).toBe(404);
        expect(none.json()).toMatchObject({ code: 'nothing_to_pick_up' });
        expect(steps).toEqual([]);
      });

      it('S9-18: tells the dialplan which caller *8 intercepts, and on which node', async () => {
        const tenantId = crypto.randomUUID();
        peers.set('201', ['102']);
        const call = await liveCall(tenantId, { ext: '102', state: 'ringing', bridged: false });
        const target = (extension: string, token = 'internal-token') =>
          app.inject({
            method: 'GET',
            url: `/internal/v1/tenants/${tenantId}/pickup-target/${extension}`,
            headers: { authorization: `Bearer ${token}` },
          });
        expect((await target('201')).json()).toEqual({ callUuid: call.caller, nodeId: 'fs-1' });
        expect((await target('305')).statusCode).toBe(404);
        expect((await target('201', 'wrong')).statusCode).toBe(401);
      });

      it('click-to-call: rings their own phone, then dials the number from it', async () => {
        const tenantId = crypto.randomUUID();
        node = new FakeNode(steps);
        const { headers } = person(tenantId, ['self.calls'], { number: '201' });
        const response = await post(`/v1/tenants/${tenantId}/me/dial`, headers, {
          to: '+14155550142',
        });
        expect(response.statusCode).toBe(200);
        const { callUuid } = response.json<{ callUuid: string }>();
        const all = commands();
        expect(all[0]).toBe('<audit>');
        expect(all[1]).toContain(`}sofia/internal/201@${DOMAIN} &park()`);
        expect(all[1]).toContain('origination_caller_id_number=+14155550142');
        expect(all.slice(2)).toEqual([
          `uuid_setvar_multi ${callUuid} sip_h_X-Call-Direction=internal;sip_h_X-Tenant-Id=${tenantId};sip_from_user=201;effective_caller_id_number=201;effective_caller_id_name=201`,
          `uuid_transfer ${callUuid} +14155550142 XML public`,
        ]);
        expect(audits()[0]).toMatchObject({
          action: 'call.dial',
          resource: 'extension:201',
          reason: 'to +14155550142',
        });
      });

      it('an unanswered phone dials nothing', async () => {
        const tenantId = crypto.randomUUID();
        node = new FakeNode(steps);
        node.originateResult = '-ERR NO_ANSWER\n';
        const { headers } = person(tenantId, ['self.calls'], { number: '201' });
        const response = await post(`/v1/tenants/${tenantId}/me/dial`, headers, { to: '102' });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ code: 'phone_not_answered' });
        expect(commands().some((command) => command.startsWith('uuid_transfer'))).toBe(false);
      });

      it('someone with no phone of their own has nothing to dial from', async () => {
        const tenantId = crypto.randomUUID();
        node = new FakeNode(steps);
        const { headers, userId } = person(tenantId, ['self.calls']);
        numbers.delete(userId);
        const response = await post(`/v1/tenants/${tenantId}/me/dial`, headers, { to: '102' });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ code: 'no_linked_extension' });
      });
    });
  },
);
