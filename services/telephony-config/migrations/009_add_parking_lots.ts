import type { Kysely } from 'kysely';

/**
 * S2-14: the local mirror of pbx-config-service's `parking_lots` (05 §3,
 * the same "local read model on the call-setup hot path" story
 * `008_add_queues.ts` already tells) — what `/fs/dialplan`'s slot-number
 * resolution and `/fs/configuration`'s `valet_parking.conf` builder both
 * resolve against.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('parking_lots')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('label', 'varchar(255)', (col) => col.notNull())
    .addColumn('slot_start', 'integer', (col) => col.notNull())
    .addColumn('slot_end', 'integer', (col) => col.notNull())
    .addColumn('timeout_seconds', 'integer', (col) => col.notNull())
    .addColumn('return_destination_type', 'varchar(16)')
    .addColumn('return_destination_id', 'varchar(36)')
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('parking_lots_tenant_idx')
    .on('parking_lots')
    .column('tenant_id')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('parking_lots').execute();
}
