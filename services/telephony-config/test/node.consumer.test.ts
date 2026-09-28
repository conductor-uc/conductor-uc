import { OpenSipsMiClientError } from '../src/opensips-mi-client.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventConsumer } from '@cuc/events';
import { databaseOrSkipReason, natsOrSkipReason } from '@cuc/testing';

import { createNodeConsumer } from '../src/consumers/node.consumer.js';
import { telephonyEvents } from '../src/events.js';
import { startBusHarness, type BusHarness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await natsOrSkipReason());

/** As in `org.consumer.test.ts`: a shared NATS server can delay a just-published message past one pull. */
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

/** S4-02 (G-123): a drained FS node leaves OpenSIPs' dispatcher rotation, and comes back. */
describe.skipIf(skipReason !== undefined)('FS node drain in the dispatcher (S4-02)', () => {
  let h: BusHarness;
  let consumer: EventConsumer;

  beforeAll(async () => {
    h = await startBusHarness();
    consumer = createNodeConsumer(h.db, h.bus, h.logger, h.opensipsProjection, h.mi, {
      pullTimeoutMs: 1000,
    });
    await consumer.ensure();
    // The stream is shared (G-17): start from nothing, not from what other suites left.
    await h.bus.jsm.streams.purge('CALL');
  });

  afterAll(async () => {
    await h?.close();
  });

  afterEach(async () => {
    await h.opensipsDb.kysely.deleteFrom('dispatcher').execute();
    await h.db.kysely.deleteFrom('consumed_events').execute();
    h.mi.queries.length = 0;
    h.mi.calls.length = 0;
    await h.bus.jsm.streams.purge('CALL');
  });

  async function seed(): Promise<void> {
    await h.opensipsDb.kysely
      .insertInto('dispatcher')
      .values([
        {
          setid: 1,
          destination: 'sip:fs1:5060',
          state: 0,
          probe_mode: 0,
          weight: '1',
          priority: 0,
          attrs: 'fs1',
        },
        {
          setid: 1,
          destination: 'sip:fs2:5060',
          state: 0,
          probe_mode: 0,
          weight: '1',
          priority: 0,
          attrs: 'fs2',
        },
        {
          setid: 1,
          destination: 'sip:unnamed:5060',
          state: 0,
          probe_mode: 0,
          weight: '1',
          priority: 0,
          attrs: null,
        },
      ])
      .execute();
  }

  async function publish(nodeId: string, draining: boolean): Promise<void> {
    const data = { nodeId, draining };
    telephonyEvents.assertPayload('call.node.drain_changed', data);
    await h.bus.publish({
      id: crypto.randomUUID(),
      type: 'call.node.drain_changed',
      schemaVersion: telephonyEvents.contract('call.node.drain_changed').schemaVersion,
      occurredAt: new Date().toISOString(),
      orgContext: {},
      data,
    });
  }

  async function states(): Promise<Record<string, number>> {
    const rows = await h.opensipsDb.kysely
      .selectFrom('dispatcher')
      .select(['destination', 'state'])
      .execute();
    return Object.fromEntries(rows.map((row) => [row.destination, row.state]));
  }

  it('sets only that node inactive, and tells OpenSIPs', async () => {
    await seed();
    await publish('fs2', true);

    expect((await runOnceUntilHandled(consumer)).handled).toBe(1);
    expect(await states()).toEqual({
      'sip:fs1:5060': 0,
      'sip:fs2:5060': 1,
      'sip:unnamed:5060': 0,
    });
    expect(h.mi.queries).toEqual([{ method: 'ds_set_state', params: ['i', 1, 'sip:fs2:5060'] }]);
  });

  it('puts an undrained node back in rotation', async () => {
    await seed();
    await publish('fs1', true);
    await publish('fs1', false);

    let handled = 0;
    for (let pass = 0; pass < 4 && handled < 2; pass++) {
      handled += (await runOnceUntilHandled(consumer)).handled;
    }
    expect(handled).toBe(2);
    expect((await states())['sip:fs1:5060']).toBe(0);
    expect(h.mi.queries.map((query) => query.params)).toEqual([
      ['i', 1, 'sip:fs1:5060'],
      ['a', 1, 'sip:fs1:5060'],
    ]);
  });

  it('S4-12: sets a node weight in the table and reloads the dispatcher', async () => {
    await seed();
    const data = { nodeId: 'fs2', weight: 3 };
    telephonyEvents.assertPayload('call.node.weight_changed', data);
    await h.bus.publish({
      id: crypto.randomUUID(),
      type: 'call.node.weight_changed',
      schemaVersion: telephonyEvents.contract('call.node.weight_changed').schemaVersion,
      occurredAt: new Date().toISOString(),
      orgContext: {},
      data,
    });

    expect((await runOnceUntilHandled(consumer)).handled).toBe(1);
    const rows = await h.opensipsDb.kysely
      .selectFrom('dispatcher')
      .select(['destination', 'weight'])
      .orderBy('id')
      .execute();
    expect(rows.map((row) => [row.destination, String(row.weight)])).toEqual([
      ['sip:fs1:5060', '1'],
      ['sip:fs2:5060', '3'],
      ['sip:unnamed:5060', '1'],
    ]);
    expect(h.mi.calls.at(-1)).toBe('ds_reload');
  });

  it("S4-04: ends a lost leg's dialog at the edge by its Call-ID, and leaves one that is already over", async () => {
    const lost = (sipCallId: string | null) => ({
      callUuid: crypto.randomUUID(),
      nodeId: 'fs2',
      direction: 'inbound' as const,
      startedAt: 1_790_000_000_000,
      answeredAt: null,
      detectedAt: 1_790_000_010_000,
      from: '+15550001111',
      to: '1001',
      extension: null,
      sipCallId,
    });
    const send = async (data: ReturnType<typeof lost>) => {
      telephonyEvents.assertPayload('call.lost', data);
      await h.bus.publish({
        id: crypto.randomUUID(),
        type: 'call.lost',
        schemaVersion: telephonyEvents.contract('call.lost').schemaVersion,
        occurredAt: new Date().toISOString(),
        orgContext: {},
        data,
      });
    };
    await send(lost('abc@edge'));
    expect((await runOnceUntilHandled(consumer)).handled).toBe(1);
    expect(h.mi.queries).toEqual([{ method: 'dlg_end_dlg', params: ['abc@edge'] }]);

    // No Call-ID known: nothing to end.
    h.mi.queries.length = 0;
    await send(lost(null));
    expect((await runOnceUntilHandled(consumer)).handled).toBe(1);
    expect(h.mi.queries).toEqual([]);

    // Already over at the edge: not an error, not retried.
    const query = h.mi.query.bind(h.mi);
    h.mi.query = () =>
      Promise.reject(
        new OpenSipsMiClientError("OpenSIPs MI 'dlg_end_dlg' failed (404): Dialog not found"),
      );
    try {
      await send(lost('gone@edge'));
      expect(await runOnceUntilHandled(consumer)).toMatchObject({ handled: 1, failed: 0 });
    } finally {
      h.mi.query = query;
    }
  });

  it('changes nothing for a node no destination names', async () => {
    await seed();
    await publish('fs9', true);

    const pass = await runOnceUntilHandled(consumer);
    expect(pass).toMatchObject({ handled: 1, failed: 0 });
    expect(Object.values(await states())).toEqual([0, 0, 0]);
    expect(h.mi.queries).toEqual([]);
  });

  it('fails the event when OpenSIPs cannot be told, so it is redelivered', async () => {
    await seed();
    const query = h.mi.query.bind(h.mi);
    h.mi.query = () => Promise.reject(new Error('OpenSIPs MI unreachable'));
    try {
      await publish('fs1', true);
      // Redelivered at once, it can fail twice in one pass.
      const pass = await runOnceUntilHandled(consumer);
      expect(pass.handled).toBe(0);
      expect(pass.failed).toBeGreaterThanOrEqual(1);
    } finally {
      h.mi.query = query;
    }
    // The table already says inactive, so an OpenSIPs restart loads it that way.
    expect((await states())['sip:fs1:5060']).toBe(1);
  });
});
