import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, natsOrSkipReason } from '@cuc/testing';

import { createConsumer, type EventHandler } from '../src/consumer.js';
import { createRelay } from '../src/relay.js';
import { testEvents, type TestDb } from './fixtures/schema.js';
import { createExtension, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await natsOrSkipReason());

describe.skipIf(skipReason !== undefined)('consumer', () => {
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
    await harness.bus.jsm.streams.purge('PBX');
  });

  function consumerFor(
    handler: EventHandler<TestDb>,
    durable = `c-${randomUUID().slice(0, 8)}`,
    overrides: { readonly nakBackoffMs?: number } = {},
  ) {
    return createConsumer<TestDb>({
      db: harness.db.kysely,
      bus: harness.bus,
      logger: harness.logger,
      registry: testEvents,
      durable,
      subjects: ['pbx.extension.created'],
      handler,
      maxDeliver: 3,
      // Short so the redelivery tests stay quick; production defaults to 500ms.
      nakBackoffMs: 20,
      ...overrides,
    });
  }

  async function publishOne(number: string): Promise<string> {
    const { eventId } = await createExtension(harness, randomUUID(), number);
    await createRelay({
      db: harness.db.kysely,
      bus: harness.bus,
      logger: harness.logger,
    }).runOnce();
    return eventId;
  }

  it('rejects a consumer with no subjects', () => {
    expect(() =>
      createConsumer<TestDb>({
        db: harness.db.kysely,
        bus: harness.bus,
        logger: harness.logger,
        registry: testEvents,
        durable: 'x',
        subjects: [],
        handler: () => Promise.resolve(),
      }),
    ).toThrow(/at least one subject/);
  });

  it('rejects subjects that span two streams', () => {
    expect(() =>
      createConsumer<TestDb>({
        db: harness.db.kysely,
        bus: harness.bus,
        logger: harness.logger,
        registry: testEvents,
        durable: 'x',
        subjects: ['pbx.extension.created', 'org.tenant.suspended'],
        handler: () => Promise.resolve(),
      }),
    ).toThrow(/one consumer per stream/i);
  });

  it('hands the handler the envelope and a transaction', async () => {
    const seen: { id: string; number: string; tenantId?: string }[] = [];

    const consumer = consumerFor(async (envelope, trx) => {
      const data = envelope.data as { number: string };
      seen.push({
        id: envelope.id,
        number: data.number,
        ...(envelope.orgContext.tenantId === undefined
          ? {}
          : { tenantId: envelope.orgContext.tenantId }),
      });
      await trx
        .insertInto('handled')
        .values({ id: randomUUID(), event_id: envelope.id, number: data.number })
        .execute();
    });
    await consumer.ensure();

    const eventId = await publishOne('7001');
    await consumer.runOnce();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: eventId, number: '7001' });
    expect(seen[0]?.tenantId).toBeTruthy();
  });

  it('records the event id, so the handler is once-only', async () => {
    const consumer = consumerFor(() => Promise.resolve(), 'dedupe-test');
    await consumer.ensure();

    const eventId = await publishOne('7002');
    await consumer.runOnce();

    const recorded = await harness.db.kysely
      .selectFrom('consumed_events')
      .selectAll()
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow();

    expect(recorded).toMatchObject({
      id: eventId,
      consumer: 'dedupe-test',
      type: 'pbx.extension.created',
    });
  });

  it('rolls back the dedupe record when the handler throws', async () => {
    let attempts = 0;
    // Back-off longer than the pull window, so exactly one delivery lands in the
    // pass under test and the count is unambiguous.
    const consumer = consumerFor(
      () => {
        attempts += 1;
        return Promise.reject(new Error('handler blew up'));
      },
      `rollback-${randomUUID().slice(0, 8)}`,
      { nakBackoffMs: 5_000 },
    );
    await consumer.ensure();

    const eventId = await publishOne('7003');
    const pass = await consumer.runOnce();

    expect(pass).toMatchObject({ handled: 0, failed: 1 });
    expect(attempts).toBe(1);

    // Nothing recorded: the handler's failure and the dedupe row are in one
    // transaction, so a redelivery gets a real second chance.
    expect(
      await harness.db.kysely
        .selectFrom('consumed_events')
        .selectAll()
        .where('id', '=', eventId)
        .execute(),
    ).toEqual([]);
  });

  it('redelivers a failed event and succeeds on the retry', async () => {
    let attempts = 0;
    const consumer = consumerFor(async (envelope, trx) => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient');
      await trx
        .insertInto('handled')
        .values({ id: randomUUID(), event_id: envelope.id, number: 'retry' })
        .execute();
    });
    await consumer.ensure();

    await publishOne('7004');

    let handled = 0;
    for (let pass = 0; pass < 4 && handled === 0; pass += 1) {
      handled += (await consumer.runOnce()).handled;
    }

    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(handled).toBe(1);
    expect(await harness.db.kysely.selectFrom('handled').selectAll().execute()).toHaveLength(1);
  });

  it('rolls back the handler’s work when it throws after writing', async () => {
    const consumer = consumerFor(async (envelope, trx) => {
      await trx
        .insertInto('handled')
        .values({ id: randomUUID(), event_id: envelope.id, number: 'doomed' })
        .execute();
      throw new Error('after the write');
    });
    await consumer.ensure();

    await publishOne('7005');
    await consumer.runOnce();

    expect(await harness.db.kysely.selectFrom('handled').selectAll().execute()).toEqual([]);
  });

  it('terminates an event that does not match its contract', async () => {
    let ran = 0;
    const consumer = consumerFor(() => {
      ran += 1;
      return Promise.resolve();
    });
    await consumer.ensure();

    // Straight onto the stream, bypassing the outbox's validation.
    await harness.bus.js.publish(
      'pbx.extension.created',
      JSON.stringify({
        id: randomUUID(),
        type: 'pbx.extension.created',
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        orgContext: {},
        data: { number: 'missing the extensionId' },
      }),
    );

    const pass = await consumer.runOnce();

    expect(pass).toMatchObject({ handled: 0, failed: 1 });
    expect(ran).toBe(0);
    // Termed, not left un-acked: retrying forever would stall every message
    // behind one that can never succeed.
    expect((await consumer.runOnce()).failed).toBe(0);
  });

  it('terminates a message that is not JSON', async () => {
    const consumer = consumerFor(() => Promise.resolve());
    await consumer.ensure();

    await harness.bus.js.publish('pbx.extension.created', 'not json at all');

    expect(await consumer.runOnce()).toMatchObject({ failed: 1 });
    expect((await consumer.runOnce()).failed).toBe(0);
  });

  it('gives up after maxDeliver redeliveries rather than stalling', async () => {
    const consumer = consumerFor(() => Promise.reject(new Error('always fails')));
    await consumer.ensure();

    await publishOne('7006');

    let failed = 0;
    for (let pass = 0; pass < 6; pass += 1) {
      failed += (await consumer.runOnce()).failed;
    }

    expect(failed).toBeGreaterThanOrEqual(3);
    // Eventually termed, so the consumer is not wedged behind it.
    expect((await consumer.runOnce()).failed).toBe(0);
  });

  it('reads only the subjects it filters on', async () => {
    const seen: string[] = [];
    const consumer = createConsumer<TestDb>({
      db: harness.db.kysely,
      bus: harness.bus,
      logger: harness.logger,
      registry: testEvents,
      durable: `filtered-${randomUUID().slice(0, 8)}`,
      subjects: ['pbx.extension.created'],
      handler: (envelope) => {
        seen.push(envelope.type);
        return Promise.resolve();
      },
    });
    await consumer.ensure();

    await publishOne('7007');
    // Something else in the same stream that this consumer does not filter on.
    await harness.bus.js.publish('pbx.queue.updated', JSON.stringify({ ignored: true }));

    await consumer.runOnce();

    expect(seen).toEqual(['pbx.extension.created']);
  });

  it('can be stopped after it has been started', async () => {
    const consumer = consumerFor(() => Promise.resolve());
    await consumer.ensure();

    const loop = consumer.run();
    await new Promise((resolve) => setTimeout(resolve, 50));
    consumer.stop();
    await loop;
  });
});
