import type { Kysely } from 'kysely';

/**
 * Per-extension call handling (parity 1a): do not disturb, the three
 * conditional forwards, forward-always, and simultaneous ring. One row per
 * extension (`extension_id` is the primary key, so 1:1 by construction); no
 * row means "nothing configured". A purely additive table, so it is safe to
 * apply ahead of the code that reads it.
 *
 * Each destination column holds one `domain/call-handling.ts` `Destination`
 * as JSON (or NULL for "not set"); `simultaneous_ring` holds a JSON array of
 * them. They are always read and written whole, never queried by field.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('extension_call_handling')
    .addColumn('extension_id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('dnd', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('dnd_action', 'varchar(16)', (col) => col.notNull().defaultTo('voicemail'))
    .addColumn('forward_always', 'json')
    .addColumn('forward_busy', 'json')
    .addColumn('forward_no_answer', 'json')
    .addColumn('no_answer_seconds', 'integer', (col) => col.notNull().defaultTo(20))
    .addColumn('forward_unreachable', 'json')
    .addColumn('simultaneous_ring', 'json', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  await db.schema
    .createIndex('extension_call_handling_tenant_idx')
    .on('extension_call_handling')
    .column('tenant_id')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('extension_call_handling').execute();
}
