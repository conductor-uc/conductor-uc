import type { Kysely } from 'kysely';

/**
 * Where the platform is reached from the internet, set by the operator in the
 * console (G-105): the one public address every reseller's names (the SIP proxy
 * and the console) are pointed at. One row. Compatible expansion only (rule 7).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('platform_network')
    .addColumn('id', 'integer', (col) => col.primaryKey())
    .addColumn('public_address', 'varchar(255)')
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('platform_network').execute();
}
