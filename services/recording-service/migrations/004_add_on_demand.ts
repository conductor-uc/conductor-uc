import type { Kysely } from 'kysely';

/**
 * S5-13 (G-111): on-demand recording and pause/resume by feature code.
 *
 * - `recording_policies.allow_on_demand`: a rule that lets the people on its calls start and stop
 *   a recording (when it does not record) or pause and resume one (when it does).
 * - `recordings.on_demand`: started by a feature code, not by a rule.
 * - `recordings.stopped_at`: when an on-demand recording was stopped by feature code (null while
 *   running, or when the call simply ended).
 * - `recordings.pause_intervals`: JSON text, `[{ "from": iso, "to": iso | null }]`, one entry per
 *   pause; an open interval (`to` null) means the recording is paused now. Paused audio is
 *   replaced by silence in the file (`uuid_record ... mask`), so the file's timeline still
 *   matches the call and these intervals say where the silence is.
 *
 * Purely additive columns with defaults.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('recording_policies')
    .addColumn('allow_on_demand', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute();
  await db.schema
    .alterTable('recordings')
    .addColumn('on_demand', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('stopped_at', 'datetime(3)')
    .addColumn('pause_intervals', 'text')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('recordings')
    .dropColumn('pause_intervals')
    .dropColumn('stopped_at')
    .dropColumn('on_demand')
    .execute();
  await db.schema.alterTable('recording_policies').dropColumn('allow_on_demand').execute();
}
