import type { Kysely } from 'kysely';

/**
 * S2-06 (G-1): who is emailed when someone in the tenant dials an emergency number. A JSON array
 * of addresses; null on routes made before, which is read as none. Additive, as migrations must
 * be (expand now, contract later).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('emergency_routes').addColumn('notify_emails', 'json').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('emergency_routes').dropColumn('notify_emails').execute();
}
