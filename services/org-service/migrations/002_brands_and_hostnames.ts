import type { Kysely } from 'kysely';

/**
 * Expands `brands` from S1-01's shell to the full field set (02 §5.4), and
 * adds `console_hostnames` (05 §3.1), which S1-01 documented but did not
 * create — a compatible expansion (rule 7): every new column is nullable, no
 * existing column changes shape.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('brands')
    .addColumn('logo_light_key', 'varchar(512)')
    .addColumn('logo_dark_key', 'varchar(512)')
    .addColumn('favicon_key', 'varchar(512)')
    .addColumn('support_email', 'varchar(255)')
    .addColumn('support_url', 'varchar(512)')
    .addColumn('support_phone', 'varchar(32)')
    .addColumn('email_from_name', 'varchar(255)')
    .addColumn('email_from_address', 'varchar(255)')
    .addColumn('sip_user_agent', 'varchar(255)')
    .addColumn('legal_footer', 'text')
    .execute();

  await db.schema
    .createTable('console_hostnames')
    .addColumn('fqdn', 'varchar(255)', (col) => col.primaryKey())
    .addColumn('reseller_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('tls_status', 'varchar(32)', (col) => col.notNull().defaultTo('pending'))
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addForeignKeyConstraint('console_hostnames_reseller_fk', ['reseller_id'], 'orgs', ['id'])
    .execute();
  await db.schema
    .createIndex('console_hostnames_reseller_idx')
    .on('console_hostnames')
    .column('reseller_id')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('console_hostnames').execute();
  await db.schema
    .alterTable('brands')
    .dropColumn('legal_footer')
    .dropColumn('sip_user_agent')
    .dropColumn('email_from_address')
    .dropColumn('email_from_name')
    .dropColumn('support_phone')
    .dropColumn('support_url')
    .dropColumn('support_email')
    .dropColumn('favicon_key')
    .dropColumn('logo_dark_key')
    .dropColumn('logo_light_key')
    .execute();
}
