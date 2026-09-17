import type { Kysely } from 'kysely';

import { createEventTables } from '@cuc/events';

/** `outbox` + `consumed_events` only — `schema.ts`'s own doc comment on why this service has no business tables of its own. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await createEventTables(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('consumed_events').execute();
  await db.schema.dropTable('outbox').execute();
}
