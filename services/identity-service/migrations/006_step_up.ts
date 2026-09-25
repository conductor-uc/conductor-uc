import type { Kysely } from 'kysely';

/**
 * Step-up confirmation (G-100). Compatible expansion only: three columns on
 * `mfa_factors`, and nothing that exists today reads them.
 *
 * - `last_step_up_step`: the TOTP time step (unix seconds / 30) of the last
 *   code accepted as a step-up. A step-up code must name a later step, so a
 *   code seen once (over a shoulder, in a proxy log) cannot confirm a second
 *   sensitive action.
 * - `step_up_failures` / `step_up_failed_at`: wrong step-up codes in the
 *   current window, so a stolen session cannot guess its way past the
 *   confirmation (see `src/auth/step-up.ts` for the limits).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('mfa_factors')
    .addColumn('last_step_up_step', 'integer')
    .addColumn('step_up_failures', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('step_up_failed_at', 'datetime(3)')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('mfa_factors')
    .dropColumn('step_up_failed_at')
    .dropColumn('step_up_failures')
    .dropColumn('last_step_up_step')
    .execute();
}
