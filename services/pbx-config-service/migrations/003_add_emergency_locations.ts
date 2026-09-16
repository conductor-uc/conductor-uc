import type { Kysely } from 'kysely';

/**
 * S2-06 (05 §3.3, G-1/issue #96): `emergency_locations`, and `extensions`'
 * own `emergency_location_id` — required at creation (issue #96: "an
 * extension cannot go live without one"), the same `notNull()` treatment
 * `002_add_dids.ts` already gives `dids.trunk_id` for the same "always
 * required, no DB-level FK across/within services either way" reasoning
 * (this codebase has none anywhere — app-level `assertReferencesExist`
 * checks are the established pattern instead).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('emergency_locations')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('label', 'varchar(255)', (col) => col.notNull())
    .addColumn('address_line1', 'varchar(255)', (col) => col.notNull())
    .addColumn('address_line2', 'varchar(255)')
    .addColumn('city', 'varchar(255)', (col) => col.notNull())
    .addColumn('state', 'varchar(64)', (col) => col.notNull())
    .addColumn('postal_code', 'varchar(32)', (col) => col.notNull())
    .addColumn('country', 'varchar(2)', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  await db.schema
    .createIndex('emergency_locations_tenant_idx')
    .on('emergency_locations')
    .column('tenant_id')
    .execute();

  await db.schema
    .alterTable('extensions')
    .addColumn('emergency_location_id', 'varchar(36)', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('extensions').dropColumn('emergency_location_id').execute();
  await db.schema.dropTable('emergency_locations').execute();
}
