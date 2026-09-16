import type { Kysely } from 'kysely';

/**
 * S2-06 (G-1): the local mirror of pbx-config-service's
 * `extensions.emergency_location_id` and trunk-service's `emergency_routes`
 * — same "local read model on the call-setup hot path" reasoning
 * `005_add_outbound_routing.ts` already used for `outbound_routes`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('extensions')
    .addColumn('emergency_location_id', 'varchar(36)', (col) => col.notNull())
    .execute();

  await db.schema
    .createTable('emergency_routes')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('trunk_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('numbers', 'json', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .execute();
  await db.schema
    .createIndex('emergency_routes_tenant_idx')
    .on('emergency_routes')
    .column('tenant_id')
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('emergency_routes').execute();
  await db.schema.alterTable('extensions').dropColumn('emergency_location_id').execute();
}
