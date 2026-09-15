import type { Kysely } from 'kysely';

import { createEventTables } from '@cuc/events';

/**
 * S1-09: extensions and their SIP credentials (05 §3.3).
 *
 * Every migration is backward compatible with the previous service version:
 * expand now, contract later, once nothing reads the old shape (CLAUDE.md
 * rule 7 / 09 §6.7).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await createEventTables(db); // outbox + consumed_events

  await db.schema
    .createTable('extensions')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('number', 'varchar(32)', (col) => col.notNull())
    .addColumn('user_id', 'varchar(36)')
    .addColumn('display_name', 'varchar(255)', (col) => col.notNull())
    .addColumn('caller_id_name', 'varchar(255)')
    .addColumn('caller_id_number', 'varchar(32)')
    .addColumn('voicemail_enabled', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  // Every tenant-owned table leads its index with tenant_id (05 §2.1); the
  // extension number is unique only within a tenant, not globally.
  await db.schema
    .createIndex('extensions_tenant_number_idx')
    .on('extensions')
    .columns(['tenant_id', 'number'])
    .unique()
    .execute();

  await db.schema
    .createTable('sip_credentials')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('extension_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('username', 'varchar(64)', (col) => col.notNull())
    .addColumn('secret_enc', 'text', (col) => col.notNull())
    .addColumn('ha1', 'char(32)', (col) => col.notNull())
    .addColumn('ha1b', 'char(32)', (col) => col.notNull())
    .addColumn('realm', 'varchar(255)', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addForeignKeyConstraint('sip_credentials_extension_fk', ['extension_id'], 'extensions', ['id'])
    .execute();

  // One credential per extension (06: "generates a SIP password" — singular).
  await db.schema
    .createIndex('sip_credentials_extension_idx')
    .on('sip_credentials')
    .column('extension_id')
    .unique()
    .execute();
  await db.schema
    .createIndex('sip_credentials_tenant_idx')
    .on('sip_credentials')
    .column('tenant_id')
    .execute();
  // What OpenSIPs' auth_db module looks the row up by (username, realm).
  await db.schema
    .createIndex('sip_credentials_username_realm_idx')
    .on('sip_credentials')
    .columns(['username', 'realm'])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('sip_credentials').execute();
  await db.schema.dropTable('extensions').execute();
  await db.schema.dropTable('consumed_events').execute();
  await db.schema.dropTable('outbox').execute();
}
