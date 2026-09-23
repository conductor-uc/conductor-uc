import type { Kysely } from 'kysely';

/**
 * S2-14 (05 §3.3; 03 §3): parking lots for `mod_valet_parking`. A lot is a
 * pinned resource (04 §3.3's `kind: 'park'`), one lease per whole lot, not
 * per slot — a single lot's slot range lives in one node's memory at a time.
 *
 * `slot_start`/`slot_end` are the inclusive numeric range a caller dials (or
 * a phone transfers to) to park or retrieve — `mod_valet_parking`'s own
 * symmetric "the second caller to dial a slot gets bridged to the first"
 * behavior is what makes park and retrieve the same dialplan action
 * (`xml.ts`'s `buildParkDialplanDocument`), so there is no separate
 * "retrieve" table or column.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('parking_lots')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('label', 'varchar(255)', (col) => col.notNull())
    .addColumn('slot_start', 'integer', (col) => col.notNull())
    .addColumn('slot_end', 'integer', (col) => col.notNull())
    .addColumn('timeout_seconds', 'integer', (col) => col.notNull())
    /** Same `DestinationType` union `queues.no_agent_destination_type`/`ring_groups.no_answer_destination_type` use. Null means "mod_valet_parking's own default" (rings the slot back to whoever parked it) — see `domain/parking-lot.ts`'s own comment on why that default isn't reimplemented here. */
    .addColumn('return_destination_type', 'varchar(16)')
    .addColumn('return_destination_id', 'varchar(36)')
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  await db.schema
    .createIndex('parking_lots_tenant_idx')
    .on('parking_lots')
    .column('tenant_id')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('parking_lots').execute();
}
