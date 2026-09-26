import type { Kysely } from 'kysely';

/**
 * S5-12 (G-111): this service's own copy of each tenant's "recording required" (fail-closed)
 * flag, projected from recording-service's `recording.settings.updated` and repaired by the
 * reconciliation pass. `/fs/dialplan` reads it only when a recording decision is unavailable,
 * which is exactly when recording-service may be unreachable, so the flag must live here.
 *
 * A tenant with no row fails open (the default). A purely additive table.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('recording_settings')
    .addColumn('tenant_id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('fail_closed', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('recording_settings').execute();
}
