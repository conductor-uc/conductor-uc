import type { Kysely } from 'kysely';

/**
 * S1-16 (G-11 (2)): a tenant's recordings and voicemail, zipped for download
 * (above all before the tenant is deleted). One row per build; it can be
 * rebuilt as often as needed, and each is kept (with its zip, in the
 * tenant's own storage) until the tenant goes.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('file_exports')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('status', 'varchar(16)', (col) => col.notNull())
    .addColumn('object_key', 'varchar(255)')
    .addColumn('size_bytes', 'bigint')
    .addColumn('file_count', 'integer')
    .addColumn('error_message', 'text')
    .addColumn('requested_by', 'varchar(36)', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .execute();
  await db.schema
    .createIndex('file_exports_tenant_idx')
    .on('file_exports')
    .columns(['tenant_id', 'created_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('file_exports').execute();
}
