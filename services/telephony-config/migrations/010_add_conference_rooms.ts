import type { Kysely } from 'kysely';

/**
 * S2-15: the local mirror of pbx-config-service's `conference_rooms` (05 §3,
 * the same "local read model on the call-setup hot path" story
 * `009_add_parking_lots.ts` already tells) — what `/fs/dialplan`'s room-
 * number resolution resolves against.
 *
 * No `pin_enc` column here: unlike a mirrored resource whose *config* the
 * dialplan needs (slot range, timeout), a PIN is a secret this service has
 * no business holding a second copy of — `conference.lua` verifies a
 * submitted PIN with a live call to pbx-config-service's own
 * `verify-pin` internal route instead (`pbx-config-client.ts`'s
 * `verifyConferencePin`). `pin_required` is the one bit of that state the
 * dialplan action itself needs, to know whether to prompt at all.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('conference_rooms')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('label', 'varchar(255)', (col) => col.notNull())
    .addColumn('number', 'varchar(16)', (col) => col.notNull())
    .addColumn('pin_required', 'boolean', (col) => col.notNull())
    .addColumn('max_members', 'integer', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('conference_rooms_tenant_idx')
    .on('conference_rooms')
    .column('tenant_id')
    .execute();
  await db.schema
    .createIndex('conference_rooms_tenant_number_idx')
    .on('conference_rooms')
    .columns(['tenant_id', 'number'])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('conference_rooms').execute();
}
