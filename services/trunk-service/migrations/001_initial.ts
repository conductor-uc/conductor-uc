import type { Kysely } from 'kysely';

import { createEventTables } from '@cuc/events';

/**
 * S2-01: trunks, trunk IPs, and their encrypted credentials (05 §3.4).
 *
 * Every migration is backward compatible with the previous service version:
 * expand now, contract later, once nothing reads the old shape (CLAUDE.md
 * rule 7 / 09 §6.7).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await createEventTables(db); // outbox + consumed_events

  await db.schema
    .createTable('trunks')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('reseller_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('name', 'varchar(255)', (col) => col.notNull())
    .addColumn('auth_mode', 'varchar(16)', (col) => col.notNull())
    .addColumn('host', 'varchar(255)', (col) => col.notNull())
    .addColumn('port', 'integer', (col) => col.notNull())
    .addColumn('transport', 'varchar(16)', (col) => col.notNull())
    .addColumn('username', 'varchar(128)')
    .addColumn('secret_enc', 'text')
    .addColumn('from_domain', 'varchar(255)')
    .addColumn('codecs', 'json', (col) => col.notNull())
    .addColumn('max_channels', 'integer')
    .addColumn('caller_id_policy', 'json')
    .addColumn('status', 'varchar(32)', (col) => col.notNull().defaultTo('active'))
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  // Every tenant-owned table leads its index with tenant_id (05 §2.1); a
  // trunk name is unique only within a tenant, not globally.
  await db.schema
    .createIndex('trunks_tenant_name_idx')
    .on('trunks')
    .columns(['tenant_id', 'name'])
    .unique()
    .execute();
  // Backs reseller-scoped listing without a cross-schema join (05 §1.1).
  await db.schema.createIndex('trunks_reseller_idx').on('trunks').column('reseller_id').execute();

  await db.schema
    .createTable('trunk_ips')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('trunk_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('cidr', 'varchar(64)', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addForeignKeyConstraint('trunk_ips_trunk_fk', ['trunk_id'], 'trunks', ['id'])
    .execute();

  await db.schema
    .createIndex('trunk_ips_trunk_cidr_idx')
    .on('trunk_ips')
    .columns(['trunk_id', 'cidr'])
    .unique()
    .execute();
  await db.schema.createIndex('trunk_ips_tenant_idx').on('trunk_ips').column('tenant_id').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('trunk_ips').execute();
  await db.schema.dropTable('trunks').execute();
  await db.schema.dropTable('consumed_events').execute();
  await db.schema.dropTable('outbox').execute();
}
