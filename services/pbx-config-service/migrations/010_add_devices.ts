import type { Kysely } from 'kysely';

/**
 * A desk phone that is provisioned for an extension (Yealink auto provisioning).
 *
 * `mac` is unique across the whole platform, not per tenant: a phone asks for
 * `<mac>.cfg`, and one MAC belonging to two tenants would be two answers to
 * one request. `token_hash` is the SHA-256 of the provisioning password; the
 * password itself is shown once when issued and never stored. It is null until
 * someone issues one, and a device with none cannot fetch a config.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('devices')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('extension_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('vendor', 'varchar(32)', (col) => col.notNull())
    .addColumn('model', 'varchar(64)')
    .addColumn('mac', 'char(12)', (col) => col.notNull())
    .addColumn('label', 'varchar(255)')
    .addColumn('token_hash', 'char(64)')
    .addColumn('last_provisioned_at', 'datetime(3)')
    .addColumn('last_seen_ip', 'varchar(64)')
    .addColumn('last_user_agent', 'varchar(255)')
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addForeignKeyConstraint('devices_extension_fk', ['extension_id'], 'extensions', ['id'])
    .execute();

  await db.schema.createIndex('devices_tenant_idx').on('devices').column('tenant_id').execute();
  await db.schema.createIndex('devices_mac_idx').on('devices').column('mac').unique().execute();
  await db.schema
    .createIndex('devices_extension_idx')
    .on('devices')
    .column('extension_id')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('devices').execute();
}
