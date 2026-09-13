import type { Logger } from '@cuc/logger';
import type { Kysely } from 'kysely';

import type { Bus } from './bus.js';
import { envelopeFromRow, type OutboxRow } from './outbox.js';
import type { EventTables } from './schema.js';

export interface RelayOptions<TDb extends EventTables = EventTables> {
  readonly db: Kysely<TDb>;
  readonly bus: Bus;
  readonly logger: Logger;
  /** Rows claimed per pass. */
  readonly batchSize?: number;
  /** Wait after a pass that found nothing. */
  readonly pollIntervalMs?: number;
  /** Attempts before a row is parked for an operator. */
  readonly maxAttempts?: number;
}

export interface RelayPass {
  readonly published: number;
  readonly duplicates: number;
  readonly failed: number;
}

export interface Relay {
  /** One pass. Returns what it did, for tests and metrics. */
  runOnce(): Promise<RelayPass>;
  /** Runs until `stop()`. Resolves once the loop has exited. */
  run(): Promise<void>;
  stop(): void;
  /** Unpublished rows still waiting, for the outbox-lag metric (09 §4). */
  lag(): Promise<number>;
}

/**
 * The relay: reads unpublished outbox rows and publishes them to JetStream
 * (05 §5).
 *
 * **Publish first, then mark sent.** The other order would lose events: a crash
 * between marking and publishing means the event is never sent and nothing knows
 * it is missing. In this order a crash between publishing and marking means the
 * row is published again on restart — at-least-once on the wire, which is the
 * contract consumers are written against.
 *
 * Two things then stop that duplicate reaching a handler: the envelope `id` goes
 * out as `Nats-Msg-Id`, so the server collapses a republish inside the stream's
 * duplicate window; and the consumer records ids in `consumed_events`, which
 * outlives both the window and any restart.
 */
export function createRelay<TDb extends EventTables>(options: RelayOptions<TDb>): Relay {
  // See `eventTablesOf` in ./outbox.ts: Kysely cannot resolve its overloads
  // against a generic schema, so the relay works with the concrete event tables.
  const db = options.db as unknown as Kysely<EventTables>;
  const { bus, logger, batchSize = 100, pollIntervalMs = 250, maxAttempts = 10 } = options;

  let running = false;
  let stopped = false;
  let wake: (() => void) | undefined;

  async function claim(): Promise<OutboxRow[]> {
    // FOR UPDATE SKIP LOCKED lets several relay instances share the outbox
    // without publishing the same row twice, and without one blocking another.
    return db
      .selectFrom('outbox')
      .select([
        'id',
        'type',
        'schema_version',
        'occurred_at',
        'tenant_id',
        'reseller_id',
        'actor_type',
        'actor_id',
        'actor_org_id',
        'correlation_id',
        'payload',
        'attempts',
      ])
      .where('published_at', 'is', null)
      .where('attempts', '<', maxAttempts)
      .where('next_attempt_at', '<=', new Date())
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(batchSize)
      .forUpdate()
      .skipLocked()
      .execute();
  }

  async function publishRow(row: OutboxRow): Promise<'published' | 'duplicate' | 'failed'> {
    const envelope = envelopeFromRow(row);

    try {
      const { duplicate } = await bus.publish(envelope);

      await db
        .updateTable('outbox')
        .set({ published_at: new Date(), last_error: null })
        .where('id', '=', row.id)
        .execute();

      if (duplicate) {
        logger.info(
          { eventId: envelope.id, type: envelope.type },
          'outbox row was already on the stream; marked sent',
        );
      } else {
        logger.debug({ eventId: envelope.id, type: envelope.type }, 'event published');
      }
      return duplicate ? 'duplicate' : 'published';
    } catch (error) {
      await recordFailure(row, error);
      return 'failed';
    }
  }

  async function recordFailure(row: OutboxRow, error: unknown): Promise<void> {
    const attempts = row.attempts + 1;
    const message = error instanceof Error ? error.message : String(error);

    await db
      .updateTable('outbox')
      .set({
        attempts,
        last_error: message.slice(0, 1000),
        next_attempt_at: new Date(Date.now() + backoffMs(attempts)),
      })
      .where('id', '=', row.id)
      .execute();

    if (attempts >= maxAttempts) {
      // Parked, not dropped. The row stays unpublished so an operator can see it
      // and requeue after fixing whatever rejected it.
      logger.error(
        { eventId: row.id, type: row.type, attempts, err: error },
        'outbox row parked after repeated publish failures',
      );
    } else {
      logger.warn(
        { eventId: row.id, type: row.type, attempts, err: error },
        'publish failed; will retry',
      );
    }
  }

  return {
    async runOnce() {
      const rows = await claim();
      let published = 0;
      let duplicates = 0;
      let failed = 0;

      for (const row of rows) {
        const outcome = await publishRow(row);
        if (outcome === 'published') published += 1;
        else if (outcome === 'duplicate') duplicates += 1;
        else failed += 1;
      }
      return { published, duplicates, failed };
    },

    async run() {
      if (running) throw new Error('This relay is already running.');
      running = true;
      stopped = false;
      logger.info({ batchSize, pollIntervalMs }, 'outbox relay started');

      while (!stopped) {
        try {
          const pass = await this.runOnce();
          if (pass.published + pass.duplicates + pass.failed > 0) continue;
        } catch (error) {
          // A database blip must not kill the relay; the next pass retries.
          logger.error({ err: error }, 'relay pass failed');
        }
        await sleep(pollIntervalMs, (resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }

      running = false;
      logger.info('outbox relay stopped');
    },

    stop() {
      stopped = true;
      wake?.();
    },

    async lag() {
      const row = await db
        .selectFrom('outbox')
        .select((eb) => eb.fn.countAll<number>().as('waiting'))
        .where('published_at', 'is', null)
        .executeTakeFirst();
      return Number(row?.waiting ?? 0);
    },
  };
}

/** Exponential back-off, capped, so a broken stream does not become a hot loop. */
function backoffMs(attempts: number): number {
  return Math.min(30_000, 2 ** Math.min(attempts, 10) * 50);
}

function sleep(ms: number, register: (resolve: () => void) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    register(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
