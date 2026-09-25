import type { Bus } from '@cuc/events';
import type { FastifyBaseLogger as Logger } from 'fastify';
import { DeliverPolicy } from '@nats-io/jetstream';

import type { BusEnvelope } from './calls.js';

/** The stream and subjects the hub reads: call-control's (the `CALL` stream, `call.>`). */
export const FEED_STREAM = 'CALL';
export const FEED_SUBJECTS = ['call.>'];

export interface EventFeed {
  /** True once the consumer is reading. */
  readonly live: boolean;
  stop(): Promise<void>;
}

export interface EventFeedOptions {
  readonly bus: Bus;
  readonly logger: Logger;
  readonly onEvent: (envelope: BusEnvelope) => void;
  /** How long to wait before trying again when the stream is not there yet or the consumer failed. */
  readonly retryDelayMs?: number;
}

/**
 * Reads `call.*` events with an **ordered consumer**: ephemeral, owned by this
 * process alone, starting at new messages, and recreated by the client library
 * if it falls out of step. Not a shared durable consumer, on purpose: every
 * gateway replica must see every event, because each serves its own sockets
 * (a durable would share the events out between replicas, each seeing only
 * some). Nothing is acknowledged or stored for it; a gateway that restarts
 * starts again from "now", and its clients get a fresh snapshot when they
 * resubscribe.
 *
 * The `CALL` stream is created by call-control (`ensureStreams()` at its
 * startup). Until it exists this keeps trying, rather than the gateway creating
 * streams itself.
 */
export function startEventFeed(options: EventFeedOptions): EventFeed {
  const { bus, logger } = options;
  const retryDelayMs = options.retryDelayMs ?? 5_000;
  let stopped = false;
  let live = false;
  let current: { stop(): void } | undefined;
  let wake: (() => void) | undefined;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const loop = (async () => {
    while (!stopped) {
      try {
        const consumer = await bus.js.consumers.get(FEED_STREAM, {
          filter_subjects: FEED_SUBJECTS,
          deliver_policy: DeliverPolicy.New,
        });
        const messages = await consumer.consume();
        current = messages;
        live = true;
        logger.info({ stream: FEED_STREAM }, 'realtime feed reading');
        for await (const message of messages) {
          let envelope: BusEnvelope;
          try {
            envelope = message.json<BusEnvelope>();
          } catch {
            continue;
          }
          if (typeof envelope !== 'object' || envelope === null) continue;
          if (typeof envelope.orgContext !== 'object' || envelope.orgContext === null) continue;
          try {
            options.onEvent(envelope);
          } catch (error) {
            logger.error({ err: error, type: envelope.type }, 'realtime fan-out failed');
          }
        }
      } catch (error) {
        if (!stopped) logger.warn({ err: error }, 'realtime feed not reading; retrying');
      }
      live = false;
      current = undefined;
      if (!stopped) await sleep(retryDelayMs);
    }
  })();

  return {
    get live() {
      return live;
    },
    async stop() {
      stopped = true;
      current?.stop();
      wake?.();
      await loop;
    },
  };
}
