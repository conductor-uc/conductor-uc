import type { Kysely } from 'kysely';

import { createEventTables } from '@cuc/events';

/**
 * Every migration is backward compatible with the previous service version:
 * expand now, contract later, once nothing reads the old shape (CLAUDE.md
 * rule 7 / 09 §6.7).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await createEventTables(db); // outbox + consumed_events

  await db.schema
    .createTable('users')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('org_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('org_type', 'varchar(16)', (col) => col.notNull())
    .addColumn('reseller_id', 'varchar(36)')
    .addColumn('email', 'varchar(255)', (col) => col.notNull())
    .addColumn('display_name', 'varchar(255)', (col) => col.notNull())
    .addColumn('password_hash', 'varchar(255)', (col) => col.notNull())
    .addColumn('status', 'varchar(16)', (col) => col.notNull().defaultTo('active'))
    .addColumn('mfa_enrolled', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('last_login_at', 'datetime(3)')
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();
  // Email is unique per org (05 §3.2), not globally.
  await db.schema
    .createIndex('users_org_email_idx')
    .on('users')
    .columns(['org_id', 'email'])
    .unique()
    .execute();

  await db.schema
    .createTable('mfa_factors')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('user_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('type', 'varchar(16)', (col) => col.notNull())
    .addColumn('secret_enc', 'text', (col) => col.notNull())
    .addColumn('confirmed_at', 'datetime(3)')
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addForeignKeyConstraint('mfa_factors_user_fk', ['user_id'], 'users', ['id'])
    .execute();
  await db.schema.createIndex('mfa_factors_user_idx').on('mfa_factors').column('user_id').execute();

  await db.schema
    .createTable('sessions')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('user_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('refresh_hash', 'varchar(64)', (col) => col.notNull())
    .addColumn('family_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('expires_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('revoked_at', 'datetime(3)')
    .addColumn('ip', 'varchar(45)')
    .addColumn('ua', 'varchar(512)')
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addForeignKeyConstraint('sessions_user_fk', ['user_id'], 'users', ['id'])
    .execute();
  // The hash is how a refresh is looked up; the family is how a reuse revokes
  // every session descended from one login.
  await db.schema
    .createIndex('sessions_refresh_hash_idx')
    .on('sessions')
    .column('refresh_hash')
    .unique()
    .execute();
  await db.schema.createIndex('sessions_family_idx').on('sessions').column('family_id').execute();

  await db.schema
    .createTable('signing_keys')
    .addColumn('id', 'varchar(64)', (col) => col.primaryKey())
    .addColumn('algorithm', 'varchar(16)', (col) => col.notNull())
    .addColumn('public_key', 'varbinary(64)', (col) => col.notNull())
    .addColumn('private_key_enc', 'text', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('retired_at', 'datetime(3)')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('signing_keys').execute();
  await db.schema.dropTable('sessions').execute();
  await db.schema.dropTable('mfa_factors').execute();
  await db.schema.dropTable('users').execute();
  await db.schema.dropTable('consumed_events').execute();
  await db.schema.dropTable('outbox').execute();
}
