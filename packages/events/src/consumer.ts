import type { EnvelopeValidator, EventEnvelope } from '@cuc/api-contracts';
import { parseSubject } from '@cuc/api-contracts';
import type { Logger } from '@cuc/logger';
import { AckPolicy, DeliverPolicy } from '@nats-io/jetstream';
import type { JsMsg } from '@nats-io/jetstream';
import type { Kysely, Transaction } from 'kysely';

import type { Bus } from './bus.js';
import type { EventTables } from './schema.js';

/**
 * A handler runs inside a transaction that also records the event id. Do the
 * work on `trx` and nothing else, and the work plus the dedupe record commit
 * together.
 */
export type EventHandler<TDb> = (envelope: EventEnvelope, trx: Transaction<TDb>) => Promise<void>;

export interface ConsumerOptions<TDb extends EventTables> {
  readonly db: Kysely<TDb>;
  readonly bus: Bus;
  readonly logger: Logger;
  /** Any registry from `@cuc/api-contracts`; only envelope validation is used. */
  readonly registry: EnvelopeValidator;
  /**
   * Durable consumer name, which must be stable across restarts — it is what
   * JetStream keys delivery state on. Use the service name, e.g.
   * `telephony-config`.
   */
  readonly durable: string;
  /** Subject filters, e.g. `['pbx.extension.created', 'pbx.extension.updated']`. */
  readonly subjects: readonly string[];
  readonly handler: EventHandler<TDb>;
  /** Messages fetched per pull. */
  readonly batchSize?: number;
  /** How long a pull waits for messages before returning empty. */
  readonly pullTimeoutMs?: number;
  /** Redeliveries before the message is termed rather than retried forever. */
  readonly maxDeliver?: number;
  /**
   * Base back-off before a failed message is redelivered, doubled per delivery.
   *
   * Without a delay, `nak` makes the message available again immediately and the
   * consumer burns every retry inside one pass — a hot loop against whatever is
   * already failing.
   */
  readonly nakBackoffMs?: number;
}

export interface ConsumerPass {
  readonly handled: number;
  /** Redeliveries whose id was already recorded, so the handler did not run. */
  readonly skipped: number;
  readonly failed: number;
}

export interface EventConsumer {
  /** Creates or updates the durable consumer. Call before the first pass. */
  ensure(): Promise<void>;
  /** One pull-and-handle pass. Returns what it did, for tests and metrics. */
  runOnce(): Promise<ConsumerPass>;
  run(): Promise<void>;
  stop(): void;
}

/**
 * A durable JetStream consumer that runs its handler at most once per event.
 *
 * Delivery is at-least-once — that is what JetStream promises, and what the
 * relay's publish-then-mark ordering produces on a crash. This turns it into
 * at-most-once *handling* with the inbox pattern: the event id is inserted into
 * `consumed_events` in the same transaction as the handler's work, so a
 * redelivery collides on the primary key and the handler is skipped (05 §5).
 *
 * A failing handler leaves the message un-acked so JetStream redelivers it. Only
 * an event the handler can never accept — one that does not match its contract —
 * is termed, because retrying it forever would block the consumer behind a
 * message that cannot succeed.
 */
export function createConsumer<TDb extends EventTables>(
  options: ConsumerOptions<TDb>,
): EventConsumer {
  // See `eventTablesOf` in ./outbox.ts. The handler still receives the caller's
  // own `Transaction<TDb>`, so its work is fully typed against the service schema.
  const db = options.db as unknown as Kysely<EventTables>;
  const {
    bus,
    logger,
    registry,
    durable,
    subjects,
    handler,
    batchSize = 50,
    pullTimeoutMs = 1_000,
    maxDeliver = 5,
    nakBackoffMs = 500,
  } = options;

  if (subjects.length === 0) throw new Error('A consumer needs at least one subject filter.');

  const streams = new Set(subjects.map((subject) => parseSubject(subject).stream));
  if (streams.size !== 1) {
    throw new Error(
      `A consumer reads one stream, but these subjects span ${[...streams].join(', ')}. ` +
        'Create one consumer per stream.',
    );
  }
  const stream = [...streams][0]!;

  let stopped = false;

  async function alreadyConsumed(
    trx: Transaction<EventTables>,
    envelope: EventEnvelope,
  ): Promise<boolean> {
    try {
      await trx
        .insertInto('consumed_events')
        .values({
          id: envelope.id,
          consumer: durable,
          type: envelope.type,
          consumed_at: new Date(),
        })
        .execute();
      return false;
    } catch (error) {
      if (isDuplicateKey(error)) return true;
      throw error;
    }
  }

  async function handleMessage(message: JsMsg): Promise<'handled' | 'skipped' | 'failed'> {
    let envelope: EventEnvelope;
    try {
      const parsed: unknown = JSON.parse(message.string());
      // An assertion signature is only honoured through an explicitly annotated
      // reference, so it cannot be called as `registry.assertEnvelope(...)`.
      const assertEnvelope: (value: unknown) => asserts value is EventEnvelope =
        registry.assertEnvelope;
      assertEnvelope(parsed);
      envelope = parsed;
    } catch (error) {
      // Unparseable or off-contract: redelivering cannot help, and leaving it
      // un-acked would stall every later message behind it.
      logger.error(
        { err: error, subject: message.subject, streamSequence: message.seq },
        'terminating event that does not match its contract',
      );
      message.term();
      return 'failed';
    }

    const log = logger.child({
      eventId: envelope.id,
      type: envelope.type,
      ...(envelope.orgContext.tenantId === undefined
        ? {}
        : { tenantId: envelope.orgContext.tenantId }),
      ...(envelope.correlationId === undefined ? {} : { correlationId: envelope.correlationId }),
    });

    try {
      const outcome = await db.transaction().execute(async (trx) => {
        if (await alreadyConsumed(trx, envelope)) return 'skipped' as const;
        await handler(envelope, trx as unknown as Transaction<TDb>);
        return 'handled' as const;
      });

      message.ack();
      if (outcome === 'skipped') log.debug('event already consumed; handler skipped');
      else log.debug('event handled');
      return outcome;
    } catch (error) {
      // Left un-acked on purpose: JetStream redelivers, and the transaction
      // rolled back, so neither the work nor the dedupe record survived.
      if (message.info.deliveryCount >= maxDeliver) {
        log.error(
          { err: error, deliveries: message.info.deliveryCount },
          'event exhausted retries; terminating',
        );
        message.term();
      } else {
        const delayMs = Math.min(30_000, nakBackoffMs * 2 ** (message.info.deliveryCount - 1));
        log.warn(
          { err: error, deliveries: message.info.deliveryCount, retryInMs: delayMs },
          'handler failed; will be redelivered',
        );
        message.nak(delayMs);
      }
      return 'failed';
    }
  }

  return {
    async ensure() {
      const config = {
        durable_name: durable,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        max_deliver: maxDeliver,
        filter_subjects: [...subjects],
      };
      try {
        await bus.jsm.consumers.add(stream, config);
        logger.info({ stream, durable, subjects }, 'durable consumer created');
      } catch {
        await bus.jsm.consumers.update(stream, durable, config);
        logger.debug({ stream, durable }, 'durable consumer already present; updated');
      }
    },

    async runOnce() {
      const consumer = await bus.js.consumers.get(stream, durable);
      const messages = await consumer.fetch({ max_messages: batchSize, expires: pullTimeoutMs });

      let handled = 0;
      let skipped = 0;
      let failed = 0;

      for await (const message of messages) {
        const outcome = await handleMessage(message);
        if (outcome === 'handled') handled += 1;
        else if (outcome === 'skipped') skipped += 1;
        else failed += 1;
      }
      return { handled, skipped, failed };
    },

    async run() {
      stopped = false;
      logger.info({ stream, durable, subjects }, 'event consumer started');

      while (!stopped) {
        try {
          await this.runOnce();
        } catch (error) {
          logger.error({ err: error }, 'consumer pass failed');
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      logger.info({ durable }, 'event consumer stopped');
    },

    stop() {
      stopped = true;
    },
  };
}

/** MariaDB reports a primary-key collision as ER_DUP_ENTRY / SQLSTATE 23000. */
function isDuplicateKey(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; errno?: unknown; cause?: unknown };

  if (candidate.code === 'ER_DUP_ENTRY' || candidate.errno === 1062) return true;
  // Kysely wraps driver errors, so the driver's own code may be one level down.
  return candidate.cause === undefined ? false : isDuplicateKey(candidate.cause);
}
