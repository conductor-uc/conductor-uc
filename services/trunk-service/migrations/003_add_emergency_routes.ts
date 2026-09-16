import type { Kysely } from 'kysely';

/**
 * S2-06: the per-tenant emergency route (05 §3.4, G-1).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('emergency_routes')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('trunk_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('numbers', 'json', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  // One per tenant (G-1: "a priority emergency route," singular) — this is
  // what actually enforces that, not just a convention `upsert` follows.
  await db.schema
    .createIndex('emergency_routes_tenant_idx')
    .on('emergency_routes')
    .column('tenant_id')
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('emergency_routes').execute();
}
