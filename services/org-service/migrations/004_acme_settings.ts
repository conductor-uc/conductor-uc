import type { Kysely } from 'kysely';

/**
 * The platform's Let's Encrypt settings, set by the operator in the console
 * rather than in configuration (G-105): who the account is registered to, which
 * Let's Encrypt (production, or the staging one that issues untrusted test
 * certificates), and that someone agreed to its terms. One row.
 *
 * The agreement is recorded against the directory it was given for, and by
 * whom and when, because agreeing to a service's terms is a person's act and
 * must not be a default. Compatible expansion only (rule 7).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('acme_settings')
    .addColumn('id', 'integer', (col) => col.primaryKey())
    .addColumn('contact_email', 'varchar(255)')
    .addColumn('directory', 'varchar(16)', (col) => col.notNull().defaultTo('production'))
    .addColumn('terms_agreed_directory', 'varchar(16)')
    .addColumn('terms_agreed_at', 'datetime(3)')
    .addColumn('terms_agreed_by', 'varchar(36)')
    .addColumn('terms_url', 'varchar(512)')
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('acme_settings').execute();
}
