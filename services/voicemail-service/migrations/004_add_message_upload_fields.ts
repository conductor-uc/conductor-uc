import type { Kysely } from 'kysely';

/**
 * S5-16: the node uploader now delivers message audio (as it does call recordings), so a
 * message row records what every stored object's row records (05 §4): the SHA-256 the
 * uploader computed, next to the existing `size_bytes`. `failure_reason` says why a message
 * never became ready (`empty_file` from the uploader, `never_uploaded` from the pending
 * sweep), the same column recording-service keeps.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('messages')
    .addColumn('sha256', 'varchar(64)')
    .addColumn('failure_reason', 'varchar(128)')
    .execute();
  // The pending sweep's query: pending messages older than a cutoff, across tenants.
  await db.schema
    .createIndex('messages_status_created_idx')
    .on('messages')
    .columns(['status', 'created_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('messages_status_created_idx').on('messages').execute();
  await db.schema
    .alterTable('messages')
    .dropColumn('sha256')
    .dropColumn('failure_reason')
    .execute();
}
