import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventConsumer } from '@cuc/events';
import { natsOrSkipReason, databaseOrSkipReason } from '@cuc/testing';

import { createTrunkConsumer } from '../src/consumers/trunk.consumer.js';
import { telephonyEvents } from '../src/events.js';
import {
  DEFAULT_DR_GROUP_ID,
  DR_TAG_WIDTH,
  drTag,
  outboundGwid,
} from '../src/repo/opensips-projection.repo.js';
import type { TrunkConfig } from '../src/trunk-config-client.js';
import { resetOpenSipsSchema, resetSchema, startBusHarness, type BusHarness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await natsOrSkipReason());

/** See `pbx.consumer.test.ts`'s identical note (gap G-17, docs/decisions.md). */
async function runOnceUntilHandled(
  consumer: EventConsumer,
  attempts = 3,
): Promise<{ handled: number; failed: number }> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const pass = await consumer.runOnce();
    if (pass.handled > 0 || pass.failed > 0 || attempt === attempts) return pass;
  }
  throw new Error('unreachable');
}

describe.skipIf(skipReason !== undefined)('trunk consumer', () => {
  let h: BusHarness;

  beforeAll(async () => {
    h = await startBusHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
    await resetOpenSipsSchema(h.opensipsDb);
    h.trunkConfig.trunks = {};
    h.trunkConfig.outboundRoutes = {};
    h.trunkConfig.emergencyRoutes = {};
    await h.bus.jsm.streams.purge('TRUNK');
  });

  function consumer() {
    return createTrunkConsumer(h.db, h.bus, h.logger, h.projection, { pullTimeoutMs: 1000 });
  }

  async function publish(
    type:
      | 'trunk.trunk.created'
      | 'trunk.trunk.updated'
      | 'trunk.trunk.deleted'
      | 'trunk.outbound_route.created'
      | 'trunk.outbound_route.updated'
      | 'trunk.outbound_route.deleted'
      | 'trunk.emergency_route.created'
      | 'trunk.emergency_route.updated'
      | 'trunk.emergency_route.deleted',
    tenantId: string,
    data: Record<string, unknown>,
  ): Promise<string> {
    const contract = telephonyEvents.contract(type);
    telephonyEvents.assertPayload(type, data);
    const id = crypto.randomUUID();
    await h.bus.publish({
      id,
      type,
      schemaVersion: contract.schemaVersion,
      occurredAt: new Date().toISOString(),
      orgContext: { tenantId },
      data,
    });
    return id;
  }

  function registerModeTrunk(overrides: Partial<TrunkConfig> = {}): TrunkConfig {
    return {
      id: crypto.randomUUID(),
      tenantId: crypto.randomUUID(),
      name: 'Primary carrier',
      authMode: 'register',
      host: 'sip.carrier.test',
      port: 5060,
      transport: 'udp',
      username: 'trunkuser',
      secret: 's3cret-password',
      fromDomain: 'acme.platform.test',
      status: 'active',
      ips: [],
      callerIdPolicy: null,
      ...overrides,
    };
  }

  it("trunk.trunk.created (register mode) projects a registrant row and a dr_gateway — S2-02's own acceptance test", async () => {
    const c = consumer();
    await c.ensure();
    const trunk = registerModeTrunk();
    h.trunkConfig.trunks[trunk.id] = trunk;

    await publish('trunk.trunk.created', trunk.tenantId, {
      trunkId: trunk.id,
      name: trunk.name,
      authMode: trunk.authMode,
    });
    const pass = await runOnceUntilHandled(c);
    expect(pass.handled).toBeGreaterThanOrEqual(1);

    const registrants = await h.opensipsProjection.listRegistrants();
    expect(registrants).toContainEqual({
      aor: `sip:trunkuser@acme.platform.test`,
      registrar: 'sip:sip.carrier.test:5060',
      bindingUri: 'sip:opensips-test:5060',
    });

    const row = await h.opensipsDb.kysely
      .selectFrom('registrant')
      .select('password')
      .where('aor', '=', 'sip:trunkuser@acme.platform.test')
      .executeTakeFirstOrThrow();
    expect(row.password).toBe('s3cret-password');

    const gateways = await h.opensipsProjection.listDrGateways();
    expect(gateways).toContain(trunk.id);

    // S2-04: a register-credential trunk's `dr_gateways.attrs` carries what
    // `uac_auth()` needs to answer the carrier's own outbound challenge.
    const gatewayRow = await h.opensipsDb.kysely
      .selectFrom('dr_gateways')
      .select('attrs')
      .where('gwid', '=', trunk.id)
      .executeTakeFirstOrThrow();
    expect(gatewayRow.attrs).toBe('trunkuser:s3cret-password:sip.carrier.test');
  });

  it('trunk.trunk.created (ip mode) projects an address row per CIDR, no registrant', async () => {
    const c = consumer();
    await c.ensure();
    const trunk = registerModeTrunk({
      authMode: 'ip',
      username: null,
      secret: null,
      ips: ['203.0.113.0/24'],
    });
    h.trunkConfig.trunks[trunk.id] = trunk;

    await publish('trunk.trunk.created', trunk.tenantId, {
      trunkId: trunk.id,
      name: trunk.name,
      authMode: trunk.authMode,
    });
    const pass = await runOnceUntilHandled(c);
    expect(pass.handled).toBeGreaterThanOrEqual(1);

    const addresses = await h.opensipsProjection.listAddresses();
    expect(addresses).toContainEqual({ trunkId: trunk.id, ip: '203.0.113.0', mask: 24 });
    expect(await h.opensipsProjection.listRegistrants()).not.toContainEqual(
      expect.objectContaining({ registrar: 'sip:sip.carrier.test:5060' }),
    );
  });

  it('trunk.trunk.updated re-fetches and moves the registrant row when the host changes', async () => {
    const c = consumer();
    await c.ensure();
    const trunk = registerModeTrunk();
    h.trunkConfig.trunks[trunk.id] = trunk;
    await publish('trunk.trunk.created', trunk.tenantId, {
      trunkId: trunk.id,
      name: trunk.name,
      authMode: trunk.authMode,
    });
    await runOnceUntilHandled(c);

    h.trunkConfig.trunks[trunk.id] = { ...trunk, host: 'sip.new-carrier.test' };
    await publish('trunk.trunk.updated', trunk.tenantId, { trunkId: trunk.id });
    const pass = await runOnceUntilHandled(c);
    expect(pass.handled).toBeGreaterThanOrEqual(1);

    const registrants = await h.opensipsProjection.listRegistrants();
    expect(registrants).toContainEqual(
      expect.objectContaining({ registrar: 'sip:sip.new-carrier.test:5060' }),
    );
    expect(registrants).not.toContainEqual(
      expect.objectContaining({ registrar: 'sip:sip.carrier.test:5060' }),
    );
  });

  it('trunk.trunk.deleted removes the registrant and dr_gateway rows', async () => {
    const c = consumer();
    await c.ensure();
    const trunk = registerModeTrunk();
    h.trunkConfig.trunks[trunk.id] = trunk;
    await publish('trunk.trunk.created', trunk.tenantId, {
      trunkId: trunk.id,
      name: trunk.name,
      authMode: trunk.authMode,
    });
    await runOnceUntilHandled(c);

    await publish('trunk.trunk.deleted', trunk.tenantId, { trunkId: trunk.id });
    const pass = await runOnceUntilHandled(c);
    expect(pass.handled).toBeGreaterThanOrEqual(1);

    // Not `toEqual([])` (G-17: the TRUNK stream is shared in CI). What this
    // test checks is that *its own* rows were removed.
    expect(await h.opensipsProjection.listRegistrants()).not.toContainEqual(
      expect.objectContaining({ registrar: 'sip:sip.carrier.test:5060' }),
    );
    expect(await h.opensipsProjection.listDrGateways()).not.toContain(trunk.id);
  });

  it('redelivery does not re-project twice (dedupe via consumed_events)', async () => {
    const c = consumer();
    await c.ensure();
    const trunk = registerModeTrunk();
    h.trunkConfig.trunks[trunk.id] = trunk;

    const eventId = await publish('trunk.trunk.created', trunk.tenantId, {
      trunkId: trunk.id,
      name: trunk.name,
      authMode: trunk.authMode,
    });
    const first = await runOnceUntilHandled(c);
    expect(first.handled).toBeGreaterThanOrEqual(1);

    await c.runOnce();
    const consumedRows = await h.db.kysely
      .selectFrom('consumed_events')
      .select('id')
      .where('id', '=', eventId)
      .execute();
    expect(consumedRows).toHaveLength(1);
  });

  describe('trunk.outbound_route.* (S2-04)', () => {
    /** A route's trunks must already be locally projected (`readModel.findTrunkById`) — `projectOutboundRoute`'s own comment on why. */
    async function projectTrunk(
      c: EventConsumer,
      tenantId: string,
      overrides: Partial<TrunkConfig> = {},
    ): Promise<string> {
      const trunk = registerModeTrunk({
        tenantId,
        authMode: 'ip',
        username: null,
        secret: null,
        ...overrides,
      });
      h.trunkConfig.trunks[trunk.id] = trunk;
      await publish('trunk.trunk.created', tenantId, {
        trunkId: trunk.id,
        name: trunk.name,
        authMode: trunk.authMode,
      });
      await runOnceUntilHandled(c);
      return trunk.id;
    }

    /** The tenant's own `dr_group_id` (`findOrCreateDrGroupId`) — not predictable in advance (`AUTO_INCREMENT`, never reset between tests in the same file run), so tests fetch it back and derive the expected {@link drTag} from it, the same way production code does. */
    async function tenantDrTag(tenantId: string): Promise<string> {
      const row = await h.db.kysely
        .selectFrom('tenant_dr_groups')
        .select('dr_group_id')
        .where('tenant_id', '=', tenantId)
        .executeTakeFirstOrThrow();
      return drTag(row.dr_group_id);
    }

    it('created projects a dr_rules row and one synthesized gateway per trunk, strip/prepend on the gateway, prefix/strip tagged by tenant (G-28/G-29)', async () => {
      const c = consumer();
      await c.ensure();
      const tenantId = crypto.randomUUID();
      const trunkA = await projectTrunk(c, tenantId, { host: 'carrier-a.test' });
      const trunkB = await projectTrunk(c, tenantId, { host: 'carrier-b.test' });
      const routeId = crypto.randomUUID();
      h.trunkConfig.outboundRoutes[routeId] = {
        id: routeId,
        tenantId,
        priority: 0,
        pattern: '+1',
        trunkIds: [trunkA, trunkB],
        strip: 1,
        prepend: '+1',
      };

      await publish('trunk.outbound_route.created', tenantId, { outboundRouteId: routeId });
      const pass = await runOnceUntilHandled(c);
      expect(pass.handled).toBeGreaterThanOrEqual(1);

      const tag = await tenantDrTag(tenantId);
      const rule = await h.opensipsDb.kysely
        .selectFrom('dr_rules')
        .selectAll()
        .where('description', '=', routeId)
        .executeTakeFirstOrThrow();
      // No leading `+` (drouting rejects one in a prefix outright, G-29)
      // and tagged by tenant ahead of the pattern's own digits (G-28) —
      // `groupid` itself is always the shared `DEFAULT_DR_GROUP_ID`, not a
      // per-tenant value; real isolation is the tag's job.
      expect(rule).toMatchObject({
        prefix: `${tag}1`,
        sort_alg: 'N',
        groupid: String(DEFAULT_DR_GROUP_ID),
      });
      const gwids = rule.gwlist!.split(',');
      expect(gwids).toHaveLength(2);

      const gateways = await h.opensipsDb.kysely
        .selectFrom('dr_gateways')
        .selectAll()
        .where('gwid', 'in', gwids)
        .orderBy('address', 'asc')
        .execute();
      expect(gateways).toHaveLength(2);
      // `strip` is the route's own value *plus* `DR_TAG_WIDTH`, since
      // `do_routing()`/`use_next_gw()` must eat the tag off `$rU` too, not
      // just what the route itself asked to strip.
      expect(gateways[0]).toMatchObject({
        address: 'carrier-a.test:5060',
        strip: DR_TAG_WIDTH + 1,
        pri_prefix: '+1',
      });
      expect(gateways[1]).toMatchObject({
        address: 'carrier-b.test:5060',
        strip: DR_TAG_WIDTH + 1,
        pri_prefix: '+1',
      });
    });

    it('assigns the same tenant tag to every route for the same tenant', async () => {
      const c = consumer();
      await c.ensure();
      const tenantId = crypto.randomUUID();
      const trunkId = await projectTrunk(c, tenantId);
      const routeA = crypto.randomUUID();
      const routeB = crypto.randomUUID();
      h.trunkConfig.outboundRoutes[routeA] = {
        id: routeA,
        tenantId,
        priority: 0,
        pattern: '+1',
        trunkIds: [trunkId],
        strip: 0,
        prepend: null,
      };
      h.trunkConfig.outboundRoutes[routeB] = {
        id: routeB,
        tenantId,
        priority: 1,
        pattern: '',
        trunkIds: [trunkId],
        strip: 0,
        prepend: null,
      };

      await publish('trunk.outbound_route.created', tenantId, { outboundRouteId: routeA });
      await runOnceUntilHandled(c);
      await publish('trunk.outbound_route.created', tenantId, { outboundRouteId: routeB });
      await runOnceUntilHandled(c);

      const tag = await tenantDrTag(tenantId);
      const rules = await h.opensipsDb.kysely
        .selectFrom('dr_rules')
        .select(['description', 'prefix'])
        .where('description', 'in', [routeA, routeB])
        .execute();
      expect(rules).toHaveLength(2);
      const byRoute = new Map(rules.map((r) => [r.description, r.prefix]));
      // routeA's pattern is '+1' (tag + '1'); routeB's is '' (the tag alone,
      // drouting's own "no digit matched -> default rule" catch-all shape).
      expect(byRoute.get(routeA)).toBe(`${tag}1`);
      expect(byRoute.get(routeB)).toBe(tag);
    });

    it('updated re-fetches and re-projects a changed trunk list, dropping the stale gateway', async () => {
      // Four sequential publish+poll round trips (two trunk projections, a
      // route create, a route update) — same "runOnce needs a retry" NATS
      // slack as `org.consumer.test.ts` (gap G-17), just with one more hop.
      const c = consumer();
      await c.ensure();
      const tenantId = crypto.randomUUID();
      const trunkA = await projectTrunk(c, tenantId, { host: 'carrier-a.test' });
      const trunkB = await projectTrunk(c, tenantId, { host: 'carrier-b.test' });
      const routeId = crypto.randomUUID();
      const route = {
        id: routeId,
        tenantId,
        priority: 0,
        pattern: '+1',
        trunkIds: [trunkA],
        strip: 0,
        prepend: null,
      };
      h.trunkConfig.outboundRoutes[routeId] = route;
      await publish('trunk.outbound_route.created', tenantId, { outboundRouteId: routeId });
      await runOnceUntilHandled(c);

      h.trunkConfig.outboundRoutes[routeId] = { ...route, trunkIds: [trunkB] };
      await publish('trunk.outbound_route.updated', tenantId, { outboundRouteId: routeId });
      const pass = await runOnceUntilHandled(c);
      expect(pass.handled).toBeGreaterThanOrEqual(1);

      const rule = await h.opensipsDb.kysely
        .selectFrom('dr_rules')
        .select('gwlist')
        .where('description', '=', routeId)
        .executeTakeFirstOrThrow();
      const gateway = await h.opensipsDb.kysely
        .selectFrom('dr_gateways')
        .select('address')
        .where('gwid', '=', rule.gwlist!)
        .executeTakeFirstOrThrow();
      expect(gateway.address).toBe('carrier-b.test:5060');

      // The stale *per-route* synthesized gateway for trunkA is gone — not
      // trunkA's own S2-02 per-trunk gateway (still used for inbound LCR,
      // and untouched by this route no longer naming it).
      const staleGateway = await h.opensipsDb.kysely
        .selectFrom('dr_gateways')
        .select('address')
        .where('gwid', '=', outboundGwid(routeId, trunkA))
        .executeTakeFirst();
      expect(staleGateway).toBeUndefined();
    }, 40000);

    it('deleted removes the dr_rules row and its synthesized gateways', async () => {
      const c = consumer();
      await c.ensure();
      const tenantId = crypto.randomUUID();
      const trunkId = await projectTrunk(c, tenantId);
      const routeId = crypto.randomUUID();
      h.trunkConfig.outboundRoutes[routeId] = {
        id: routeId,
        tenantId,
        priority: 0,
        pattern: '+1',
        trunkIds: [trunkId],
        strip: 0,
        prepend: null,
      };
      await publish('trunk.outbound_route.created', tenantId, { outboundRouteId: routeId });
      await runOnceUntilHandled(c);

      const before = await h.opensipsDb.kysely
        .selectFrom('dr_rules')
        .select('gwlist')
        .where('description', '=', routeId)
        .executeTakeFirstOrThrow();

      await publish('trunk.outbound_route.deleted', tenantId, { outboundRouteId: routeId });
      const pass = await runOnceUntilHandled(c);
      expect(pass.handled).toBeGreaterThanOrEqual(1);

      const rules = await h.opensipsDb.kysely
        .selectFrom('dr_rules')
        .select('ruleid')
        .where('description', '=', routeId)
        .execute();
      expect(rules).toHaveLength(0);

      const gateways = await h.opensipsDb.kysely
        .selectFrom('dr_gateways')
        .select('gwid')
        .where('gwid', '=', before.gwlist!)
        .execute();
      expect(gateways).toHaveLength(0);
    });
  });

  describe('trunk.emergency_route.* (S2-06)', () => {
    /** Same "must already be locally projected" precondition `trunk.outbound_route.*`'s own `projectTrunk` documents. */
    async function projectTrunk(
      c: EventConsumer,
      tenantId: string,
      overrides: Partial<TrunkConfig> = {},
    ): Promise<string> {
      const trunk = registerModeTrunk({
        tenantId,
        authMode: 'ip',
        username: null,
        secret: null,
        ...overrides,
      });
      h.trunkConfig.trunks[trunk.id] = trunk;
      await publish('trunk.trunk.created', tenantId, {
        trunkId: trunk.id,
        name: trunk.name,
        authMode: trunk.authMode,
      });
      await runOnceUntilHandled(c);
      return trunk.id;
    }

    async function tenantDrTag(tenantId: string): Promise<string> {
      const row = await h.db.kysely
        .selectFrom('tenant_dr_groups')
        .select('dr_group_id')
        .where('tenant_id', '=', tenantId)
        .executeTakeFirstOrThrow();
      return drTag(row.dr_group_id);
    }

    it('created projects one synthesized gateway and one dr_rules row per number, sharing the gateway (G-1)', async () => {
      const c = consumer();
      await c.ensure();
      const tenantId = crypto.randomUUID();
      const trunkId = await projectTrunk(c, tenantId, { host: 'carrier-e911.test' });
      const routeId = crypto.randomUUID();
      h.trunkConfig.emergencyRoutes[routeId] = {
        id: routeId,
        tenantId,
        trunkId,
        numbers: ['911', '933'],
      };

      await publish('trunk.emergency_route.created', tenantId, { emergencyRouteId: routeId });
      const pass = await runOnceUntilHandled(c);
      expect(pass.handled).toBeGreaterThanOrEqual(1);

      const tag = await tenantDrTag(tenantId);
      const rules = await h.opensipsDb.kysely
        .selectFrom('dr_rules')
        .selectAll()
        .where('description', 'in', [`${routeId}:911`, `${routeId}:933`])
        .orderBy('prefix', 'asc')
        .execute();
      expect(rules).toHaveLength(2);
      expect(rules[0]).toMatchObject({
        prefix: `${tag}911`,
        sort_alg: 'N',
        groupid: String(DEFAULT_DR_GROUP_ID),
      });
      expect(rules[1]).toMatchObject({
        prefix: `${tag}933`,
        sort_alg: 'N',
        groupid: String(DEFAULT_DR_GROUP_ID),
      });
      // One trunk, one synthesized gateway — reused across both numbers'
      // own rules, not a gateway per number.
      expect(rules[0]!.gwlist).toBe(rules[1]!.gwlist);
      const gwids = rules[0]!.gwlist!.split(',');
      expect(gwids).toHaveLength(1);

      const gateway = await h.opensipsDb.kysely
        .selectFrom('dr_gateways')
        .selectAll()
        .where('gwid', '=', gwids[0]!)
        .executeTakeFirstOrThrow();
      expect(gateway).toMatchObject({
        address: 'carrier-e911.test:5060',
        strip: DR_TAG_WIDTH,
        pri_prefix: null,
      });
    });

    it('updated re-projects a changed number list, dropping the stale per-number rule', async () => {
      const c = consumer();
      await c.ensure();
      const tenantId = crypto.randomUUID();
      const trunkId = await projectTrunk(c, tenantId);
      const routeId = crypto.randomUUID();
      h.trunkConfig.emergencyRoutes[routeId] = {
        id: routeId,
        tenantId,
        trunkId,
        numbers: ['911', '933'],
      };
      await publish('trunk.emergency_route.created', tenantId, { emergencyRouteId: routeId });
      await runOnceUntilHandled(c);

      h.trunkConfig.emergencyRoutes[routeId] = {
        id: routeId,
        tenantId,
        trunkId,
        numbers: ['911'],
      };
      await publish('trunk.emergency_route.updated', tenantId, { emergencyRouteId: routeId });
      const pass = await runOnceUntilHandled(c);
      expect(pass.handled).toBeGreaterThanOrEqual(1);

      const rules = await h.opensipsDb.kysely
        .selectFrom('dr_rules')
        .select('description')
        .where('description', 'like', `${routeId}:%`)
        .execute();
      expect(rules.map((r) => r.description)).toEqual([`${routeId}:911`]);
    });

    it('deleted removes the dr_rules rows and the synthesized gateway', async () => {
      const c = consumer();
      await c.ensure();
      const tenantId = crypto.randomUUID();
      const trunkId = await projectTrunk(c, tenantId);
      const routeId = crypto.randomUUID();
      h.trunkConfig.emergencyRoutes[routeId] = {
        id: routeId,
        tenantId,
        trunkId,
        numbers: ['911', '933'],
      };
      await publish('trunk.emergency_route.created', tenantId, { emergencyRouteId: routeId });
      await runOnceUntilHandled(c);

      const before = await h.opensipsDb.kysely
        .selectFrom('dr_rules')
        .select('gwlist')
        .where('description', '=', `${routeId}:911`)
        .executeTakeFirstOrThrow();

      await publish('trunk.emergency_route.deleted', tenantId, { emergencyRouteId: routeId });
      const pass = await runOnceUntilHandled(c);
      expect(pass.handled).toBeGreaterThanOrEqual(1);

      const rules = await h.opensipsDb.kysely
        .selectFrom('dr_rules')
        .select('ruleid')
        .where('description', 'like', `${routeId}:%`)
        .execute();
      expect(rules).toHaveLength(0);

      const gateways = await h.opensipsDb.kysely
        .selectFrom('dr_gateways')
        .select('gwid')
        .where('gwid', '=', before.gwlist!)
        .execute();
      expect(gateways).toHaveLength(0);
    });
  });
});
