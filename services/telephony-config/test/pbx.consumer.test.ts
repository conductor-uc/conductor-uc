import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventConsumer } from '@cuc/events';
import { natsOrSkipReason, databaseOrSkipReason } from '@cuc/testing';

import { createPbxConsumer } from '../src/consumers/pbx.consumer.js';
import { telephonyEvents } from '../src/events.js';
import { resetOpenSipsSchema, resetSchema, startBusHarness, type BusHarness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await natsOrSkipReason());

/**
 * `pass.handled` assertions below use `toBeGreaterThanOrEqual(1)`, not
 * `toBe(1)`: see `org.consumer.test.ts`'s identical note (gap G-17,
 * docs/decisions.md) — this file's PBX stream is not known to collide with
 * any other suite's tests today, but the same shared-server risk applies to
 * any future one that publishes real `pbx.*` events.
 */
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

describe.skipIf(skipReason !== undefined)('pbx consumer', () => {
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
    h.pbxConfig.credentials = {};
    h.pbxConfig.dids = {};
    await h.bus.jsm.streams.purge('PBX');
  });

  function consumer() {
    return createPbxConsumer(h.db, h.bus, h.logger, h.projection, { pullTimeoutMs: 5000 });
  }

  /** Returns the published envelope's own id, for a dedupe check that names it exactly. */
  async function publish(
    type:
      | 'pbx.extension.created'
      | 'pbx.extension.updated'
      | 'pbx.extension.deleted'
      | 'pbx.did.created'
      | 'pbx.did.updated'
      | 'pbx.did.deleted',
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

  it("pbx.extension.created projects the subscriber row — S1-12's own acceptance test", async () => {
    const c = consumer();
    await c.ensure();
    const tenantId = crypto.randomUUID();
    const extensionId = crypto.randomUUID();
    h.pbxConfig.credentials[extensionId] = {
      extensionId,
      number: '101',
      username: '101',
      ha1: 'a'.repeat(32),
      ha1b: 'b'.repeat(32),
      realm: 'acme.platform.test',
      callerIdName: null,
      callerIdNumber: null,
    };

    await publish('pbx.extension.created', tenantId, {
      extensionId,
      number: '101',
      displayName: 'Front Desk',
    });
    const pass = await runOnceUntilHandled(c);
    expect(pass.handled).toBeGreaterThanOrEqual(1);

    const subscribers = await h.opensipsProjection.listSubscribers();
    expect(subscribers).toEqual([{ username: '101', domain: 'acme.platform.test' }]);

    const row = await h.opensipsDb.kysely
      .selectFrom('subscriber')
      .select('ha1')
      .where('username', '=', '101')
      .executeTakeFirstOrThrow();
    expect(row.ha1).toBe('a'.repeat(32));
  });

  it('pbx.extension.updated re-fetches and re-projects, moving the row if the realm changed', async () => {
    const c = consumer();
    await c.ensure();
    const tenantId = crypto.randomUUID();
    const extensionId = crypto.randomUUID();
    h.pbxConfig.credentials[extensionId] = {
      extensionId,
      number: '101',
      username: '101',
      ha1: 'a'.repeat(32),
      ha1b: 'b'.repeat(32),
      realm: 'old.platform.test',
      callerIdName: null,
      callerIdNumber: null,
    };
    await publish('pbx.extension.created', tenantId, {
      extensionId,
      number: '101',
      displayName: 'Front Desk',
    });
    await runOnceUntilHandled(c);

    h.pbxConfig.credentials[extensionId] = {
      extensionId,
      number: '101',
      username: '101',
      ha1: 'c'.repeat(32),
      ha1b: 'd'.repeat(32),
      realm: 'new.platform.test',
      callerIdName: null,
      callerIdNumber: null,
    };
    await publish('pbx.extension.updated', tenantId, { extensionId });
    const pass = await runOnceUntilHandled(c);
    expect(pass.handled).toBeGreaterThanOrEqual(1);

    const subscribers = await h.opensipsProjection.listSubscribers();
    expect(subscribers).toEqual([{ username: '101', domain: 'new.platform.test' }]);
  });

  it('pbx.extension.deleted removes the subscriber row', async () => {
    const c = consumer();
    await c.ensure();
    const tenantId = crypto.randomUUID();
    const extensionId = crypto.randomUUID();
    h.pbxConfig.credentials[extensionId] = {
      extensionId,
      number: '101',
      username: '101',
      ha1: 'a'.repeat(32),
      ha1b: 'b'.repeat(32),
      realm: 'acme.platform.test',
      callerIdName: null,
      callerIdNumber: null,
    };
    await publish('pbx.extension.created', tenantId, {
      extensionId,
      number: '101',
      displayName: 'Front Desk',
    });
    await runOnceUntilHandled(c);

    await publish('pbx.extension.deleted', tenantId, { extensionId });
    const pass = await runOnceUntilHandled(c);
    expect(pass.handled).toBeGreaterThanOrEqual(1);

    // Not `toEqual([])` (G-17: the PBX stream is shared in CI, so a
    // different suite's own, unrelated extension-created event can land in
    // this same pull) — what this test checks is that *its own* subscriber
    // row was removed.
    expect(await h.opensipsProjection.listSubscribers()).not.toContainEqual({
      username: '101',
      domain: 'acme.platform.test',
    });
  });

  it('redelivery does not re-project twice (dedupe via consumed_events)', async () => {
    const c = consumer();
    await c.ensure();
    const tenantId = crypto.randomUUID();
    const extensionId = crypto.randomUUID();
    h.pbxConfig.credentials[extensionId] = {
      extensionId,
      number: '101',
      username: '101',
      ha1: 'a'.repeat(32),
      ha1b: 'b'.repeat(32),
      realm: 'acme.platform.test',
      callerIdName: null,
      callerIdNumber: null,
    };

    const eventId = await publish('pbx.extension.created', tenantId, {
      extensionId,
      number: '101',
      displayName: 'Front Desk',
    });
    const first = await runOnceUntilHandled(c);
    expect(first.handled).toBeGreaterThanOrEqual(1);

    // A second pass is not asserted empty (G-17: streams are shared with any
    // other package's own concurrently-running consumer tests). What proves
    // dedupe is that *our own* event was recorded exactly once —
    // `consumed_events.id` is its primary key, so processing it twice would
    // collide and roll back.
    await c.runOnce();
    const consumedRows = await h.db.kysely
      .selectFrom('consumed_events')
      .select('id')
      .where('id', '=', eventId)
      .execute();
    expect(consumedRows).toHaveLength(1);
  });

  it("pbx.did.created projects the DID into this service's own local mirror (S2-03)", async () => {
    const c = consumer();
    await c.ensure();
    const tenantId = crypto.randomUUID();
    const didId = crypto.randomUUID();
    const trunkId = crypto.randomUUID();
    const destinationId = crypto.randomUUID();
    h.pbxConfig.dids[didId] = {
      id: didId,
      e164: '+15551234567',
      trunkId,
      destinationType: 'extension',
      destinationId,
    };

    await publish('pbx.did.created', tenantId, { didId, e164: '+15551234567' });
    const pass = await runOnceUntilHandled(c);
    expect(pass.handled).toBeGreaterThanOrEqual(1);

    const did = await h.readModel.findDidByE164(tenantId, '+15551234567');
    expect(did).toMatchObject({ id: didId, trunkId, destinationType: 'extension', destinationId });
  });

  it('pbx.did.updated re-fetches and re-projects a changed trunk binding', async () => {
    const c = consumer();
    await c.ensure();
    const tenantId = crypto.randomUUID();
    const didId = crypto.randomUUID();
    const trunkA = crypto.randomUUID();
    const trunkB = crypto.randomUUID();
    const destinationId = crypto.randomUUID();
    h.pbxConfig.dids[didId] = {
      id: didId,
      e164: '+15551234567',
      trunkId: trunkA,
      destinationType: 'extension',
      destinationId,
    };
    await publish('pbx.did.created', tenantId, { didId, e164: '+15551234567' });
    await runOnceUntilHandled(c);

    h.pbxConfig.dids[didId] = {
      id: didId,
      e164: '+15551234567',
      trunkId: trunkB,
      destinationType: 'extension',
      destinationId,
    };
    await publish('pbx.did.updated', tenantId, { didId });
    const pass = await runOnceUntilHandled(c);
    expect(pass.handled).toBeGreaterThanOrEqual(1);

    const did = await h.readModel.findDidByE164(tenantId, '+15551234567');
    expect(did?.trunkId).toBe(trunkB);
  });

  it('pbx.did.deleted removes the local mirror row', async () => {
    const c = consumer();
    await c.ensure();
    const tenantId = crypto.randomUUID();
    const didId = crypto.randomUUID();
    h.pbxConfig.dids[didId] = {
      id: didId,
      e164: '+15551234567',
      trunkId: crypto.randomUUID(),
      destinationType: 'extension',
      destinationId: crypto.randomUUID(),
    };
    await publish('pbx.did.created', tenantId, { didId, e164: '+15551234567' });
    await runOnceUntilHandled(c);

    await publish('pbx.did.deleted', tenantId, { didId });
    const pass = await runOnceUntilHandled(c);
    expect(pass.handled).toBeGreaterThanOrEqual(1);

    expect(await h.readModel.findDidByE164(tenantId, '+15551234567')).toBeUndefined();
  });
});
