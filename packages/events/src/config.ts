import { Env, Type } from '@cuc/config';

/** Event bus configuration every service that publishes or consumes needs. */
export const eventsEnvSchema = Type.Object({
  NATS_SERVERS: Env.list({
    default: ['127.0.0.1:4222'],
    description: 'Comma-separated NATS endpoints, e.g. nats-1:4222,nats-2:4222.',
  }),
  NATS_USER: Env.optional(Env.string({ description: 'NATS user, when not using an nkey.' })),
  NATS_PASSWORD: Env.optional(Env.secret()),
  NATS_NKEY_SEED: Env.optional(
    Env.secret({ description: 'nkey seed from the orchestrator secret store.' }),
  ),
  OUTBOX_BATCH_SIZE: Env.int({
    minimum: 1,
    maximum: 1000,
    default: 100,
    description: 'Outbox rows the relay claims per pass.',
  }),
  OUTBOX_POLL_INTERVAL_MS: Env.int({
    minimum: 10,
    default: 250,
    description: 'How long the relay waits after an empty pass.',
  }),
  OUTBOX_MAX_ATTEMPTS: Env.int({
    minimum: 1,
    default: 10,
    description: 'Publish attempts before a row is parked for an operator.',
  }),
  OUTBOX_RETENTION_DAYS: Env.int({
    minimum: 0,
    default: 7,
    description:
      'Published outbox rows older than this many days are deleted by the relay (G-55). 0 keeps them.',
  }),
  NATS_STREAM_MAX_AGE_DAYS: Env.int({
    minimum: 0,
    maximum: 3650,
    default: 7,
    description:
      'Messages older than this many days leave every JetStream stream (G-55). 0 keeps them until a size limit applies. Set the same value in every service.',
  }),
});
