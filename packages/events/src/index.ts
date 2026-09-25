export {
  connectBus,
  DEFAULT_STREAM_MAX_AGE_DAYS,
  DUPLICATE_WINDOW_MS,
  MSG_ID_HEADER,
  type Bus,
  type BusOptions,
} from './bus.js';
export { eventsEnvSchema } from './config.js';
export {
  createConsumer,
  type ConsumerOptions,
  type ConsumerPass,
  type EventConsumer,
  type EventHandler,
} from './consumer.js';
export { enqueueEvent, envelopeFromRow, type OutboxRow, type PublishRequest } from './outbox.js';
export {
  createRelay,
  DEFAULT_OUTBOX_RETENTION_DAYS,
  type Relay,
  type RelayOptions,
  type RelayPass,
} from './relay.js';
export {
  createConsumedEventsTable,
  createEventTables,
  createOutboxTable,
  type EventTables,
} from './schema.js';

// Re-exported so a service declares events and handlers from one import.
export type { EventEnvelope, EventRegistry, PayloadOf } from '@cuc/api-contracts';
