import { allStreams, type EventEnvelope } from '@cuc/api-contracts';
import type { Logger } from '@cuc/logger';
import { DiscardPolicy, RetentionPolicy, jetstream, jetstreamManager } from '@nats-io/jetstream';
import type { JetStreamClient, JetStreamManager } from '@nats-io/jetstream';
import { headers } from '@nats-io/nats-core';
import type { NatsConnection } from '@nats-io/nats-core';
import { connect } from '@nats-io/transport-node';

/**
 * Header JetStream uses for server-side deduplication. Set to the envelope `id`,
 * so a relay that republishes a row inside the duplicate window is collapsed by
 * the server rather than reaching a consumer at all.
 */
export const MSG_ID_HEADER = 'Nats-Msg-Id';

/**
 * How long a stream remembers message ids for deduplication.
 *
 * Two minutes comfortably covers a relay crash and restart, which is the case
 * this exists for. It is a window, not a guarantee: the consumer's
 * `consumed_events` table is what makes dedupe durable (05 §5).
 */
export const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

export interface BusOptions {
  readonly servers: readonly string[];
  readonly user?: string;
  readonly password?: string;
  readonly logger: Logger;
  /** Identifies this connection in `nats server report connections`. */
  readonly name: string;
}

export interface Bus {
  readonly js: JetStreamClient;
  readonly jsm: JetStreamManager;
  readonly connection: NatsConnection;
  /** Publishes one envelope. Returns false when the server saw it as a duplicate. */
  publish(envelope: EventEnvelope): Promise<{ sequence: number; duplicate: boolean }>;
  /** Creates any stream that does not exist yet, and widens subjects if needed. */
  ensureStreams(): Promise<void>;
  /** For `GET /readyz`. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/** Connects to NATS and returns the JetStream handles. */
export async function connectBus(options: BusOptions): Promise<Bus> {
  const { logger } = options;

  const connection = await connect({
    servers: [...options.servers],
    name: options.name,
    ...(options.user === undefined ? {} : { user: options.user }),
    ...(options.password === undefined ? {} : { pass: options.password }),
  });

  const jsm = await jetstreamManager(connection);
  const js = jetstream(connection);

  return {
    js,
    jsm,
    connection,

    async publish(envelope) {
      const messageHeaders = headers();
      messageHeaders.set(MSG_ID_HEADER, envelope.id);

      const ack = await js.publish(envelope.type, JSON.stringify(envelope), {
        headers: messageHeaders,
      });
      return { sequence: ack.seq, duplicate: ack.duplicate };
    },

    async ensureStreams() {
      for (const stream of allStreams()) {
        const config = {
          name: stream.name,
          subjects: [...stream.subjects],
          retention: RetentionPolicy.Limits,
          discard: DiscardPolicy.Old,
          duplicate_window: DUPLICATE_WINDOW_MS * 1_000_000,
        };
        try {
          await jsm.streams.add(config);
          logger.info({ stream: stream.name }, 'stream created');
        } catch (error) {
          // Already present: bring its config up to date rather than failing
          // startup, so adding a domain does not need a manual step.
          await jsm.streams.update(stream.name, config);
          logger.debug({ stream: stream.name, err: error }, 'stream already present; updated');
        }
      }
    },

    async ping() {
      try {
        await connection.flush();
        return !connection.isClosed();
      } catch (error) {
        logger.error({ err: error }, 'bus ping failed');
        return false;
      }
    },

    async close() {
      await connection.drain();
    },
  };
}
