import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, natsOrSkipReason } from '@cuc/testing';

import { createConsumer } from '../src/consumer.js';
import { createRelay } from '../src/relay.js';
import { testEvents, type TestDb } from './fixtures/schema.js';
import { createExtension, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await natsOrSkipReason());

/**
 * S0-04's acceptance criterion: at-least-once delivery, with no duplicates
 * reaching the handler after a relay crash and restart.
 *
 * The crash is simulated at the one moment that actually matters — after the
 * event is on the stream, before the outbox row is marked sent. That is the only
 * window the relay's publish-then-mark ordering leaves open, and it is left open
 * deliberately: the other order loses events instead of duplicating them.
 */
describe.skipIf(skipReason !== undefined)('relay crash and restart', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.db.kysely.deleteFrom('handled').execute();
    await harness.db.kysely.deleteFrom('consumed_events').execute();
    await harness.db.kysely.deleteFrom('outbox').execute();
    await harness.db.kysely.deleteFrom('extensions').execute();
    // Consumers use DeliverPolicy.All, which is right in production — a new
    // consumer must see everything the stream still holds. Here it means a fresh
    // durable would replay the previous test's events, so the stream is emptied
    // alongside the tables.
    await harness.bus.jsm.streams.purge('PBX');
  });

  /** A consumer whose handler records every invocation, so duplicates are visible. */
  function consumerFor(durable: string) {
    const invocations: string[] = [];

    const consumer = createConsumer<TestDb>({
      db: harness.db.kysely,
      bus: harness.bus,
      logger: harness.logger,
      registry: testEvents,
      durable,
      subjects: ['pbx.extension.created'],
      handler: async (envelope, trx) => {
        invocations.push(envelope.id);
        const data = envelope.data as { extensionId: string; number: string };
        await trx
          .insertInto('handled')
          .values({ id: randomUUID(), event_id: envelope.id, number: data.number })
          .execute();
      },
    });

    return { consumer, invocations };
  }

  it('delivers the event once when nothing goes wrong', async () => {
    const durable = `baseline-${randomUUID().slice(0, 8)}`;
    const { consumer, invocations } = consumerFor(durable);
    await consumer.ensure();

    const { eventId } = await createExtension(harness, randomUUID(), '1001');

    const relay = createRelay({ db: harness.db.kysely, bus: harness.bus, logger: harness.logger });
    expect(await relay.runOnce()).toMatchObject({ published: 1, duplicates: 0, failed: 0 });

    const pass = await consumer.runOnce();

    expect(pass).toMatchObject({ handled: 1, skipped: 0, failed: 0 });
    expect(invocations).toEqual([eventId]);
    expect(await handledCount()).toBe(1);
  });

  it('publishes again after a crash between publishing and marking sent', async () => {
    const { eventId } = await createExtension(harness, randomUUID(), '1002');

    // The crash: publish to the stream, then die before the outbox row is
    // updated. This is the relay's own publish path, stopped mid-way.
    const firstAck = await harness.bus.publish({
      id: eventId,
      type: 'pbx.extension.created',
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      orgContext: {},
      data: { extensionId: 'e1', number: '1002' },
    });
    expect(firstAck.duplicate).toBe(false);

    // Restart: the row still looks unpublished, so the relay sends it again.
    const restarted = createRelay({
      db: harness.db.kysely,
      bus: harness.bus,
      logger: harness.logger,
    });
    const pass = await restarted.runOnce();

    // At-least-once on the wire. The server recognised the id and collapsed it,
    // and the row is now marked sent either way.
    expect(pass).toMatchObject({ published: 0, duplicates: 1, failed: 0 });
    expect(await unpublishedCount()).toBe(0);
  });

  it('runs the handler exactly once even though the event was published twice', async () => {
    const durable = `crash-${randomUUID().slice(0, 8)}`;
    const { consumer, invocations } = consumerFor(durable);
    await consumer.ensure();

    const { eventId } = await createExtension(harness, randomUUID(), '1003');

    const relay = createRelay({ db: harness.db.kysely, bus: harness.bus, logger: harness.logger });
    await relay.runOnce();

    expect(await consumer.runOnce()).toMatchObject({ handled: 1 });

    // The same event reaches the stream a second time, and the server does not
    // recognise it — which is what a relay restart produces once the stream's
    // duplicate window has expired. This is the case that matters: the window is
    // a convenience, and only `consumed_events` is durable.
    await republishOutsideDuplicateWindow(eventId, '1003');

    const second = await consumer.runOnce();

    // The redelivery reached the consumer, and `consumed_events` stopped it at
    // the handler. That is the difference between at-least-once delivery and
    // at-least-once *handling*.
    expect(second.handled).toBe(0);
    expect(second.skipped).toBeGreaterThanOrEqual(1);
    expect(invocations).toEqual([eventId]);
    expect(await handledCount()).toBe(1);
  });

  it('survives a relay restart on a fresh connection', async () => {
    const durable = `restart-${randomUUID().slice(0, 8)}`;
    const { consumer, invocations } = consumerFor(durable);
    await consumer.ensure();

    const { eventId } = await createExtension(harness, randomUUID(), '1004');

    // First relay publishes, then "crashes" before marking the row.
    const crashingBus = await harness.newBus('relay-1');
    await crashingBus.publish({
      id: eventId,
      type: 'pbx.extension.created',
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      orgContext: {},
      data: { extensionId: 'e1', number: '1004' },
    });
    await crashingBus.close();

    // A brand-new relay on a brand-new connection picks the row up.
    const secondBus = await harness.newBus('relay-2');
    const relay = createRelay({ db: harness.db.kysely, bus: secondBus, logger: harness.logger });
    await relay.runOnce();

    let handled = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      handled += (await consumer.runOnce()).handled;
    }

    expect(handled).toBe(1);
    expect(invocations).toEqual([eventId]);
    expect(await handledCount()).toBe(1);
    expect(await unpublishedCount()).toBe(0);
  });

  it('keeps every event when several are published across a crash', async () => {
    const durable = `many-${randomUUID().slice(0, 8)}`;
    const { consumer, invocations } = consumerFor(durable);
    await consumer.ensure();

    const tenantId = randomUUID();
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const { eventId } = await createExtension(harness, tenantId, `20${String(index)}`);
      ids.push(eventId);
    }

    // Two of the five were already on the stream when the relay died.
    for (const eventId of ids.slice(0, 2)) {
      await harness.bus.publish({
        id: eventId,
        type: 'pbx.extension.created',
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        orgContext: { tenantId },
        data: { extensionId: 'e', number: '2000' },
      });
    }

    const relay = createRelay({ db: harness.db.kysely, bus: harness.bus, logger: harness.logger });
    const pass = await relay.runOnce();

    expect(pass.published + pass.duplicates).toBe(5);
    expect(pass.duplicates).toBe(2);
    expect(pass.failed).toBe(0);

    let handled = 0;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      handled += (await consumer.runOnce()).handled;
    }

    expect(handled).toBe(5);
    expect(new Set(invocations).size).toBe(5);
    expect(await handledCount()).toBe(5);
    expect(await unpublishedCount()).toBe(0);
  });

  async function handledCount(): Promise<number> {
    const row = await harness.db.kysely
      .selectFrom('handled')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .executeTakeFirst();
    return Number(row?.total ?? 0);
  }

  async function unpublishedCount(): Promise<number> {
    const row = await harness.db.kysely
      .selectFrom('outbox')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where('published_at', 'is', null)
      .executeTakeFirst();
    return Number(row?.total ?? 0);
  }

  /**
   * Publishes an envelope the server will not recognise as a duplicate, by
   * omitting the `Nats-Msg-Id` header the relay normally sets.
   *
   * That is exactly what the server sees from a relay republishing after its
   * duplicate window expired, and it reproduces the case without mutating the
   * shared stream's configuration — which would leak into every later test.
   */
  async function republishOutsideDuplicateWindow(eventId: string, number: string): Promise<void> {
    await harness.bus.js.publish(
      'pbx.extension.created',
      JSON.stringify({
        id: eventId,
        type: 'pbx.extension.created',
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        orgContext: {},
        data: { extensionId: 'e1', number },
      }),
    );
  }
});
