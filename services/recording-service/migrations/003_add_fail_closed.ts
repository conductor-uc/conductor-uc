import type { Kysely } from 'kysely';

/**
 * S5-12 (G-111): a tenant can require recording. With `fail_closed` on, a call whose recording
 * decision cannot be made (recording-service unreachable, or the recording cannot be registered)
 * is refused instead of going ahead unrecorded. Off by default: availability over completeness
 * stays the default. telephony-config keeps its own copy (from `recording.settings.updated`), so
 * the flag holds while this service is down. A purely additive column.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('recording_settings')
    .addColumn('fail_closed', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('recording_settings').dropColumn('fail_closed').execute();
}
