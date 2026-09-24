import type { Kysely } from 'kysely';

/**
 * Parity 1a: the local mirror of pbx-config-service's
 * `extension_call_handling` — what `/fs/dialplan` reads on every call to an
 * extension (05 §3, the same "local read model on the call-setup hot path"
 * story `009_add_parking_lots.ts` tells). The whole document is one JSON
 * column: the dialplan always reads all of it, and never queries by field.
 * An extension with nothing configured has no row.
 *
 * A purely additive table.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('extension_call_handling')
    .addColumn('extension_id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('settings', 'json', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
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
