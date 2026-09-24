import type { Kysely } from 'kysely';

/**
 * TLS certificates the platform obtains and keeps for the hostnames phones and
 * browsers connect to (G-105): one SIP proxy hostname per reseller and one for
 * the platform itself, and each console hostname.
 *
 * Everything lives in the database, as decided: the certificate chain, the
 * private key (envelope-encrypted, never stored in the clear here), the ACME
 * account key, and the short-lived HTTP challenge answers the edge serves on
 * port 80. `next_attempt_at` is what the issuing worker leases and retries on.
 * Compatible expansion only (rule 7): nothing existing changes shape.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('tls_certificates')
    .addColumn('fqdn', 'varchar(255)', (col) => col.primaryKey())
    .addColumn('purpose', 'varchar(16)', (col) => col.notNull())
    .addColumn('reseller_id', 'varchar(36)')
    .addColumn('status', 'varchar(16)', (col) => col.notNull().defaultTo('pending'))
    .addColumn('certificate_pem', 'text')
    .addColumn('private_key_enc', 'text')
    .addColumn('not_before', 'datetime(3)')
    .addColumn('not_after', 'datetime(3)')
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('next_attempt_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('last_error', 'varchar(1024)')
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .execute();
  await db.schema
    .createIndex('tls_certificates_due_idx')
    .on('tls_certificates')
    .columns(['status', 'next_attempt_at'])
    .execute();
  await db.schema
    .createIndex('tls_certificates_reseller_idx')
    .on('tls_certificates')
    .column('reseller_id')
    .execute();

  await db.schema
    .createTable('acme_challenges')
    .addColumn('token', 'varchar(128)', (col) => col.primaryKey())
    .addColumn('fqdn', 'varchar(255)', (col) => col.notNull())
    .addColumn('key_authorization', 'varchar(512)', (col) => col.notNull())
    .addColumn('expires_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .execute();

  await db.schema
    .createTable('acme_accounts')
    .addColumn('directory_url', 'varchar(255)', (col) => col.primaryKey())
    .addColumn('account_key_enc', 'text', (col) => col.notNull())
    .addColumn('account_url', 'varchar(512)')
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('acme_accounts').execute();
  await db.schema.dropTable('acme_challenges').execute();
  await db.schema.dropTable('tls_certificates').execute();
}
