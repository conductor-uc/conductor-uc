import type { Kysely } from 'kysely';

import { createEventTables } from '@cuc/events';

/**
 * Every migration is backward compatible with the previous service version:
 * expand now, contract later (CLAUDE.md rule 7 / 09 §6.7).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await createEventTables(db); // outbox + consumed_events

  await db.schema
    .createTable('sent_emails')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('event_id', 'varchar(64)', (col) => col.notNull())
    .addColumn('template', 'varchar(64)', (col) => col.notNull())
    .addColumn('to_address', 'varchar(255)', (col) => col.notNull())
    .addColumn('org_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('brand_reseller', 'varchar(36)')
    .addColumn('sent_at', 'datetime(3)', (col) => col.notNull())
    .execute();
  await db.schema
    .createIndex('sent_emails_event_idx')
    .on('sent_emails')
    .column('event_id')
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('sent_emails').execute();
  await db.schema.dropTable('consumed_events').execute();
  await db.schema.dropTable('outbox').execute();
}
