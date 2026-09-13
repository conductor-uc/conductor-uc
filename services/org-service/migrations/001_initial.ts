import { sql, type Kysely } from 'kysely';

import { createEventTables } from '@cuc/events';

/**
 * Every migration is backward compatible with the previous service version:
 * expand now, contract later, once nothing reads the old shape (CLAUDE.md
 * rule 7 / 09 §6.7).
 *
 * `reseller_base_domains`, `tenant_domains`, and `brands` are shells here —
 * enough to be referenced, with their real columns and constraints landing in
 * S1-03 and S1-04 as compatible expansions.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await createEventTables(db); // outbox + consumed_events

  await db.schema
    .createTable('orgs')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('type', 'varchar(16)', (col) => col.notNull())
    .addColumn('parent_id', 'varchar(36)')
    .addColumn('reseller_id', 'varchar(36)')
    .addColumn('slug', 'varchar(63)', (col) => col.notNull())
    .addColumn('name', 'varchar(255)', (col) => col.notNull())
    .addColumn('status', 'varchar(32)', (col) => col.notNull().defaultTo('active'))
    .addColumn('timezone', 'varchar(64)', (col) => col.notNull().defaultTo('UTC'))
    .addColumn('country', 'varchar(2)', (col) => col.notNull().defaultTo('US'))
    .addColumn('limits', 'json', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .addForeignKeyConstraint('orgs_parent_fk', ['parent_id'], 'orgs', ['id'])
    .addForeignKeyConstraint('orgs_reseller_fk', ['reseller_id'], 'orgs', ['id'])
    .addCheckConstraint('orgs_type_valid', sql`type in ('master', 'reseller', 'tenant')`)
    // 02 §1: the master has no parent; every other org does.
    .addCheckConstraint(
      'orgs_master_has_no_parent',
      sql`(type = 'master' and parent_id is null) or (type <> 'master' and parent_id is not null)`,
    )
    // reseller_id is the denormalized owning reseller, set only on tenants
    // (05 §3.1: "reseller_id (null for master/reseller)").
    .addCheckConstraint(
      'orgs_reseller_id_only_for_tenant',
      sql`(type = 'tenant' and reseller_id is not null) or (type <> 'tenant' and reseller_id is null)`,
    )
    .execute();

  await db.schema.createIndex('orgs_slug_idx').on('orgs').column('slug').unique().execute();
  await db.schema.createIndex('orgs_parent_idx').on('orgs').column('parent_id').execute();
  await db.schema.createIndex('orgs_reseller_idx').on('orgs').column('reseller_id').execute();

  // The single-master invariant (02 §1) as a real constraint rather than only
  // an application check: a virtual column that is 1 for a master row and
  // NULL otherwise, with a unique index on it. MariaDB's unique index allows
  // any number of NULLs, so this rejects a second master while imposing
  // nothing on reseller and tenant rows. Kysely's column builder has no
  // MariaDB generated-column support, hence the raw statement — allowed here,
  // since migrations are one of the two places raw SQL belongs (05 §2.2).
  await sql`
    alter table orgs
      add column master_singleton tinyint
        generated always as (if(type = 'master', 1, null)) virtual,
      add unique key orgs_single_master_idx (master_singleton)
  `.execute(db);

  await db.schema
    .createTable('reseller_base_domains')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('reseller_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('fqdn', 'varchar(255)', (col) => col.notNull())
    .addColumn('verification_token', 'varchar(255)', (col) => col.notNull())
    .addColumn('verified_at', 'datetime(3)')
    .addColumn('status', 'varchar(32)', (col) => col.notNull().defaultTo('pending'))
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addForeignKeyConstraint('reseller_base_domains_reseller_fk', ['reseller_id'], 'orgs', ['id'])
    .execute();
  await db.schema
    .createIndex('reseller_base_domains_fqdn_idx')
    .on('reseller_base_domains')
    .column('fqdn')
    .unique()
    .execute();

  await db.schema
    .createTable('tenant_domains')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('fqdn', 'varchar(255)', (col) => col.notNull())
    .addColumn('is_primary', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addForeignKeyConstraint('tenant_domains_tenant_fk', ['tenant_id'], 'orgs', ['id'])
    .execute();
  await db.schema
    .createIndex('tenant_domains_fqdn_idx')
    .on('tenant_domains')
    .column('fqdn')
    .unique()
    .execute();
  await db.schema
    .createIndex('tenant_domains_tenant_idx')
    .on('tenant_domains')
    .column('tenant_id')
    .execute();

  await db.schema
    .createTable('brands')
    .addColumn('reseller_id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('display_name', 'varchar(255)')
    .addColumn('primary_color', 'varchar(9)')
    .addColumn('accent_color', 'varchar(9)')
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addForeignKeyConstraint('brands_reseller_fk', ['reseller_id'], 'orgs', ['id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('brands').execute();
  await db.schema.dropTable('tenant_domains').execute();
  await db.schema.dropTable('reseller_base_domains').execute();
  await db.schema.dropTable('orgs').execute();
  await db.schema.dropTable('consumed_events').execute();
  await db.schema.dropTable('outbox').execute();
}
