import type { Kysely } from 'kysely';

/**
 * The `outbox` and `consumed_events` tables, as a service declares them for
 * Kysely. Spread into the service's own `DB` interface.
 */
export interface EventTables {
  outbox: {
    /** The event id (UUIDv7), which becomes the envelope `id`. */
    id: string;
    type: string;
    schema_version: number;
    occurred_at: Date;
    tenant_id: string | null;
    reseller_id: string | null;
    actor_type: string | null;
    actor_id: string | null;
    actor_org_id: string | null;
    correlation_id: string | null;
    /** The envelope `data`, as JSON text. */
    payload: string;
    created_at: Date;
    /** Null until the relay has published it. */
    published_at: Date | null;
    attempts: number;
    last_error: string | null;
    /** When the relay may next try. Back-off after a failure. */
    next_attempt_at: Date;
  };
  consumed_events: {
    /** The envelope `id`. Primary key: this is what makes the handler once-only. */
    id: string;
    consumer: string;
    type: string;
    consumed_at: Date;
  };
}

/**
 * Creates the `outbox` table.
 *
 * Call it from a service's first migration. It is a template rather than a
 * shared table because each service owns its own schema (05 §1.1) and writes its
 * outbox row in the same transaction as its business rows.
 *
 * `tenant_id` is nullable on purpose: master-level events such as
 * `org.reseller.created` belong to no tenant, so the outbox is not a
 * tenant-scoped table and is never reached through `scoped(ctx)`.
 */
export async function createOutboxTable(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('outbox')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('type', 'varchar(128)', (col) => col.notNull())
    .addColumn('schema_version', 'integer', (col) => col.notNull())
    .addColumn('occurred_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('tenant_id', 'varchar(36)')
    .addColumn('reseller_id', 'varchar(36)')
    .addColumn('actor_type', 'varchar(16)')
    .addColumn('actor_id', 'varchar(36)')
    .addColumn('actor_org_id', 'varchar(36)')
    .addColumn('correlation_id', 'varchar(128)')
    .addColumn('payload', 'json', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('published_at', 'datetime(3)')
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('last_error', 'text')
    .addColumn('next_attempt_at', 'datetime(3)', (col) => col.notNull())
    .execute();

  // The relay's only query: unpublished rows that are due, oldest first. Leading
  // with published_at keeps the index small once most rows are sent.
  await db.schema
    .createIndex('outbox_unpublished_idx')
    .on('outbox')
    .columns(['published_at', 'next_attempt_at', 'created_at'])
    .execute();
}

/**
 * Creates the `consumed_events` table.
 *
 * This is the inbox half: the event id is the primary key, and the consumer
 * records it in the same transaction as the handler's work. A redelivery then
 * fails the insert and the handler is never run twice (05 §5).
 *
 * It is deliberately in the database rather than Redis: the SAD makes Redis
 * ephemeral, and dedupe has to outlive a restart and JetStream's duplicate
 * window.
 */
export async function createConsumedEventsTable(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('consumed_events')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('consumer', 'varchar(128)', (col) => col.notNull())
    .addColumn('type', 'varchar(128)', (col) => col.notNull())
    .addColumn('consumed_at', 'datetime(3)', (col) => col.notNull())
    .execute();

  // Retention sweeps delete by age.
  await db.schema
    .createIndex('consumed_events_consumed_at_idx')
    .on('consumed_events')
    .columns(['consumed_at'])
    .execute();
}

/** Both tables, for a service's first migration. */
export async function createEventTables(db: Kysely<unknown>): Promise<void> {
  await createOutboxTable(db);
  await createConsumedEventsTable(db);
}
