import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, natsOrSkipReason } from '@cuc/testing';

import { createRelay } from '../src/relay.js';
import type { Bus } from '../src/bus.js';
import { createExtension, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await natsOrSkipReason());

describe.skipIf(skipReason !== undefined)('relay', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.db.kysely.deleteFrom('outbox').execute();
    await harness.db.kysely.deleteFrom('extensions').execute();
    await harness.bus.jsm.streams.purge('PBX');
  });

  /** A bus whose publish always fails, to exercise the retry path. */
  function failingBus(message = 'no route to stream'): Bus {
    return {
      ...harness.bus,
      publish: () => Promise.reject(new Error(message)),
    };
  }

  async function row(id: string) {
    return harness.db.kysely
      .selectFrom('outbox')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  it('publishes nothing when the outbox is empty', async () => {
    const relay = createRelay({ db: harness.db.kysely, bus: harness.bus, logger: harness.logger });

    expect(await relay.runOnce()).toEqual({ published: 0, duplicates: 0, failed: 0 });
  });

  it('marks a row sent only after it is on the stream', async () => {
    const { eventId } = await createExtension(harness, randomUUID(), '1001');

    await createRelay({
      db: harness.db.kysely,
      bus: harness.bus,
      logger: harness.logger,
    }).runOnce();

    expect((await row(eventId)).published_at).not.toBeNull();
  });

  it('leaves a row unpublished when the publish fails', async () => {
    const { eventId } = await createExtension(harness, randomUUID(), '1002');

    const pass = await createRelay({
      db: harness.db.kysely,
      bus: failingBus(),
      logger: harness.logger,
    }).runOnce();

    expect(pass).toMatchObject({ published: 0, failed: 1 });
    const after = await row(eventId);
    expect(after.published_at).toBeNull();
    expect(after.attempts).toBe(1);
    expect(after.last_error).toContain('no route to stream');
  });

  it('backs off, so a broken stream does not become a hot loop', async () => {
    const { eventId } = await createExtension(harness, randomUUID(), '1003');
    const relay = createRelay({
      db: harness.db.kysely,
      bus: failingBus(),
      logger: harness.logger,
    });

    await relay.runOnce();
    const first = await row(eventId);

    // The row is not due again yet, so a second pass finds nothing to claim.
    expect(first.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    expect(await relay.runOnce()).toMatchObject({ published: 0, failed: 0 });
  });

  it('parks a row after maxAttempts instead of dropping it', async () => {
    const { eventId } = await createExtension(harness, randomUUID(), '1004');
    const relay = createRelay({
      db: harness.db.kysely,
      bus: failingBus(),
      logger: harness.logger,
      maxAttempts: 2,
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await harness.db.kysely
        .updateTable('outbox')
        .set({ next_attempt_at: new Date(Date.now() - 1000) })
        .where('id', '=', eventId)
        .execute();
      await relay.runOnce();
    }

    const parked = await row(eventId);
    expect(parked.attempts).toBe(2);
    // Still there, unpublished, with the reason recorded — an operator can requeue
    // it once whatever rejected it is fixed.
    expect(parked.published_at).toBeNull();
    expect(parked.last_error).toBeTruthy();

    // And it is no longer claimed, so it cannot block the rows behind it.
    await harness.db.kysely
      .updateTable('outbox')
      .set({ next_attempt_at: new Date(Date.now() - 1000) })
      .where('id', '=', eventId)
      .execute();
    expect(await relay.runOnce()).toEqual({ published: 0, duplicates: 0, failed: 0 });
  });

  it('publishes in the order the events were written', async () => {
    const tenantId = randomUUID();
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const { eventId } = await createExtension(harness, tenantId, `30${String(index)}`);
      ids.push(eventId);
    }

    const published: string[] = [];
    const recordingBus: Bus = {
      ...harness.bus,
      publish: async (envelope) => {
        published.push(envelope.id);
        return harness.bus.publish(envelope);
      },
    };

    await createRelay({
      db: harness.db.kysely,
      bus: recordingBus,
      logger: harness.logger,
    }).runOnce();

    expect(published).toEqual(ids);
  });

  it('claims at most batchSize rows per pass', async () => {
    const tenantId = randomUUID();
    for (let index = 0; index < 5; index += 1) {
      await createExtension(harness, tenantId, `40${String(index)}`);
    }

    const relay = createRelay({
      db: harness.db.kysely,
      bus: harness.bus,
      logger: harness.logger,
      batchSize: 2,
    });

    expect((await relay.runOnce()).published).toBe(2);
    expect((await relay.runOnce()).published).toBe(2);
    expect((await relay.runOnce()).published).toBe(1);
    expect((await relay.runOnce()).published).toBe(0);
  });

  it('reports outbox lag, for the metric in 09 §4', async () => {
    const relay = createRelay({ db: harness.db.kysely, bus: harness.bus, logger: harness.logger });
    expect(await relay.lag()).toBe(0);

    const tenantId = randomUUID();
    await createExtension(harness, tenantId, '5001');
    await createExtension(harness, tenantId, '5002');
    expect(await relay.lag()).toBe(2);

    await relay.runOnce();
    expect(await relay.lag()).toBe(0);
  });

  describe('retention of published rows (G-55)', () => {
    const DAY = 24 * 60 * 60_000;

    /** Publishes [count] rows, then backdates their publish time by [ageDays]. */
    async function publishedRows(count: number, ageDays: number): Promise<string[]> {
      const tenantId = randomUUID();
      const ids: string[] = [];
      for (let index = 0; index < count; index += 1) {
        ids.push((await createExtension(harness, tenantId, `7${String(index)}`)).eventId);
      }
      await harness.db.kysely
        .updateTable('outbox')
        .set({ published_at: new Date(Date.now() - ageDays * DAY) })
        .where('id', 'in', ids)
        .execute();
      return ids;
    }

    async function remaining(): Promise<string[]> {
      const rows = await harness.db.kysely.selectFrom('outbox').select('id').execute();
      return rows.map((r) => r.id);
    }

    it('deletes published rows older than the retention period, in batches', async () => {
      const old = await publishedRows(5, 8);
      const recent = await publishedRows(2, 6);
      const { eventId: unpublished } = await createExtension(harness, randomUUID(), '7999');
      // Unpublished for a long time: parked, not delivered. Never deleted.
      await harness.db.kysely
        .updateTable('outbox')
        .set({ created_at: new Date(Date.now() - 30 * DAY), attempts: 99 })
        .where('id', '=', unpublished)
        .execute();

      const relay = createRelay({
        db: harness.db.kysely,
        bus: harness.bus,
        logger: harness.logger,
        retentionDays: 7,
        cleanupBatchSize: 2,
      });

      expect(await relay.purgePublished()).toBe(old.length);
      expect((await remaining()).sort()).toEqual([...recent, unpublished].sort());
      expect(await relay.purgePublished()).toBe(0);
    });

    it('keeps everything when the retention is 0', async () => {
      const old = await publishedRows(3, 400);
      const relay = createRelay({
        db: harness.db.kysely,
        bus: harness.bus,
        logger: harness.logger,
        retentionDays: 0,
      });

      expect(await relay.purgePublished()).toBe(0);
      expect((await remaining()).sort()).toEqual([...old].sort());
    });

    it('sweeps from the running loop, without anyone asking', async () => {
      await publishedRows(3, 10);
      const relay = createRelay({
        db: harness.db.kysely,
        bus: harness.bus,
        logger: harness.logger,
        pollIntervalMs: 20,
      });

      const loop = relay.run();
      await waitFor(async () => (await remaining()).length === 0);
      relay.stop();
      await loop;
    });
  });

  describe('run and stop', () => {
    it('drains the outbox and then stops on request', async () => {
      const tenantId = randomUUID();
      await createExtension(harness, tenantId, '6001');
      await createExtension(harness, tenantId, '6002');

      const relay = createRelay({
        db: harness.db.kysely,
        bus: harness.bus,
        logger: harness.logger,
        pollIntervalMs: 20,
      });

      const loop = relay.run();
      await waitFor(async () => (await relay.lag()) === 0);
      relay.stop();
      await loop;

      expect(await relay.lag()).toBe(0);
    });

    it('refuses to run twice on one instance', async () => {
      const relay = createRelay({
        db: harness.db.kysely,
        bus: harness.bus,
        logger: harness.logger,
        pollIntervalMs: 20,
      });

      const loop = relay.run();
      await expect(relay.run()).rejects.toThrow(/already running/);
      relay.stop();
      await loop;
    });
  });
});

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition was not met in time');
}
