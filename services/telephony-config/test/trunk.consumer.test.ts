import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventConsumer } from '@cuc/events';
import { natsOrSkipReason, databaseOrSkipReason } from '@cuc/testing';

import { createTrunkConsumer } from '../src/consumers/trunk.consumer.js';
import { telephonyEvents } from '../src/events.js';
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
    await h.bus.jsm.streams.purge('TRUNK');
  });

  function consumer() {
    return createTrunkConsumer(h.db, h.bus, h.logger, h.projection, { pullTimeoutMs: 5000 });
  }

  async function publish(
    type: 'trunk.trunk.created' | 'trunk.trunk.updated' | 'trunk.trunk.deleted',
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
});
