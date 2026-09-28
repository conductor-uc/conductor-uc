import type { Kysely } from 'kysely';

/**
 * S9-18 (G-125): `pickup_groups`, the extensions whose ringing calls each of
 * them may pick up (from the portal, or by dialing `*8`). `member_extension_ids`
 * is a JSON array of `extensions.id`, as `ring_groups` keeps its members.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('pickup_groups')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('label', 'varchar(255)', (col) => col.notNull())
    .addColumn('member_extension_ids', 'json', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  await db.schema
    .createIndex('pickup_groups_tenant_idx')
    .on('pickup_groups')
    .column('tenant_id')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('pickup_groups').execute();
}
