import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * S5-06 (O-3): voicemail transcription, off by default. A tenant opts in (and picks the
 * engine), a mailbox may follow the tenant, or be turned on or off by itself, and each ready
 * message carries its transcript and where that stands. Additive only.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('transcription_settings')
    .addColumn('tenant_id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('engine', 'varchar(16)', (col) => col.notNull().defaultTo('default'))
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  await db.schema
    .alterTable('mailboxes')
    .addColumn('transcribe', 'varchar(8)', (col) => col.notNull().defaultTo('inherit'))
    .execute();

  await db.schema
    .alterTable('messages')
    .addColumn('transcript', sql`text`)
    .addColumn('transcript_status', 'varchar(10)', (col) => col.notNull().defaultTo('none'))
    .addColumn('transcript_engine', 'varchar(16)')
    .addColumn('transcript_attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('transcript_claimed_at', 'datetime(3)')
    .execute();
  // The transcriber's query: the oldest message waiting, across tenants.
  await db.schema
    .createIndex('messages_transcript_status_idx')
    .on('messages')
    .columns(['transcript_status', 'created_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('messages_transcript_status_idx').on('messages').execute();
  await db.schema
    .alterTable('messages')
    .dropColumn('transcript')
    .dropColumn('transcript_status')
    .dropColumn('transcript_engine')
    .dropColumn('transcript_attempts')
    .dropColumn('transcript_claimed_at')
    .execute();
  await db.schema.alterTable('mailboxes').dropColumn('transcribe').execute();
  await db.schema.dropTable('transcription_settings').execute();
}
