import type { Kysely } from 'kysely';

/**
 * One event can now send several emails (G-100: a two-step reset notice goes
 * to the person and to the org's other admins), so `sent_emails` is unique per
 * event and recipient rather than per event. Compatible with the previous
 * service version, which only ever wrote one row per event.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex('sent_emails_event_to_idx')
    .on('sent_emails')
    .columns(['event_id', 'to_address'])
    .unique()
    .execute();
  await db.schema.dropIndex('sent_emails_event_idx').on('sent_emails').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex('sent_emails_event_idx')
    .on('sent_emails')
    .column('event_id')
    .unique()
    .execute();
  await db.schema.dropIndex('sent_emails_event_to_idx').on('sent_emails').execute();
}
