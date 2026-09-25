import type { Kysely } from 'kysely';

import { createEventTables } from '@cuc/events';

/** `outbox` + `consumed_events` only; the recording tables come in 002. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await createEventTables(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('consumed_events').execute();
  await db.schema.dropTable('outbox').execute();
}
