import type { Kysely } from 'kysely';

/**
 * S5-07: per-mailbox voicemail-to-email settings. `notify_email` null means
 * "do not email" (there is no separate enabled flag to fall out of step with
 * it). `email_after` is what happens to the message once the email is out:
 * `keep`, `mark_read`, or `delete`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('mailboxes')
    .addColumn('notify_email', 'varchar(254)')
    .addColumn('email_attach_audio', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('email_after', 'varchar(16)', (col) => col.notNull().defaultTo('keep'))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('mailboxes')
    .dropColumn('notify_email')
    .dropColumn('email_attach_audio')
    .dropColumn('email_after')
    .execute();
}
