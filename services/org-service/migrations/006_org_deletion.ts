import type { Kysely } from 'kysely';

/**
 * S1-16 (G-11): deleting an org. Asking suspends it and sets `delete_after`
 * 30 days on (`pending_deletion`); cancelling in that time puts back the
 * status it had (`status_before_deletion`); once `delete_after` passes the row
 * becomes `deleted` (`deleted_at`) and every service removes the org's data.
 * The row itself stays, as a tombstone: its slug is reserved for 90 days
 * after deletion (02 §3).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('orgs')
    .addColumn('deletion_requested_at', 'datetime(3)')
    .addColumn('delete_after', 'datetime(3)')
    .addColumn('status_before_deletion', 'varchar(32)')
    .addColumn('deleted_at', 'datetime(3)')
    .execute();
  await db.schema
    .createIndex('orgs_delete_after_idx')
    .on('orgs')
    .columns(['status', 'delete_after'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('orgs_delete_after_idx').on('orgs').execute();
  await db.schema
    .alterTable('orgs')
    .dropColumn('deletion_requested_at')
    .dropColumn('delete_after')
    .dropColumn('status_before_deletion')
    .dropColumn('deleted_at')
    .execute();
}
