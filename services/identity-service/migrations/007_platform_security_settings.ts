import type { Kysely } from 'kysely';

/**
 * The platform's sign-in policy, edited by the master in the console (D-012
 * as amended 2026-09-28). One row, `id = 1`; no row means the defaults, which
 * is how a fresh install starts: the master's own users are not required to
 * set up two-step verification until an administrator turns it on, once the
 * platform is configured. Reseller users are required regardless.
 *
 * - `require_master_mfa`: whether the master org's users must enrol at sign-in.
 * - `updated_by`: the user who last changed it, for the console to show.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('platform_security_settings')
    .addColumn('id', 'integer', (col) => col.primaryKey())
    .addColumn('require_master_mfa', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('updated_by', 'varchar(36)')
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('platform_security_settings').execute();
}
