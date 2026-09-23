import type { Kysely } from 'kysely';

/**
 * S2-13 (05 §3.3; 03 §3): queue, agent, and tier config for `mod_callcenter`.
 *
 * Three tables, matching `mod_callcenter`'s own real data model (queues /
 * agents / tiers) rather than collapsing "agent" into a queue-membership
 * row: an agent is one durable identity (one row per extension acting as an
 * agent, `agents.extension_id` unique per tenant) that can be tiered into
 * several queues at once, the same "agent belongs to N queues, not the
 * other way around" shape mod_callcenter itself assumes. `queue_tiers` is
 * the many-to-many join, carrying the per-(queue, agent) `level`/`position`
 * mod_callcenter's own tier ordering needs.
 *
 * Deliberately no `status` column on `agents`: an agent's live logged-in/
 * on-break/logged-out state is `mod_callcenter`'s own in-memory state, set
 * directly by the login/logout feature codes (`xml.ts`'s
 * `buildAgentStatusDialplanDocument`, telephony-config) via `callcenter_
 * config agent set status` — writing it back here would just be a second,
 * eventually-inconsistent copy of state FS already owns authoritatively.
 * `call.queue.agentStatusChanged` (call-control, from the ESL `callcenter::
 * info` event) is how the rest of the platform observes it instead.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('queues')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('label', 'varchar(255)', (col) => col.notNull())
    /** `domain/queue.ts`'s `QUEUE_STRATEGIES` — one of `mod_callcenter`'s own `strategy` param values. */
    .addColumn('strategy', 'varchar(32)', (col) => col.notNull())
    /** A `media_assets.id` in this tenant, or null for FS's own default hold music. */
    .addColumn('moh_media_asset_id', 'varchar(36)')
    /** 0 = unlimited (mod_callcenter's own convention for `max-wait-time`). */
    .addColumn('max_wait_seconds', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('announce_position', 'boolean', (col) => col.notNull().defaultTo(false))
    /** Null when `announce_position` is false. */
    .addColumn('announce_frequency_seconds', 'integer')
    /** Same `DestinationType` union `dids.destination_type`/`ring_groups.no_answer_destination_type` use — where an abandoned or maxed-out caller goes. Null means "just stop waiting". */
    .addColumn('no_agent_destination_type', 'varchar(16)')
    .addColumn('no_agent_destination_id', 'varchar(36)')
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  await db.schema.createIndex('queues_tenant_idx').on('queues').column('tenant_id').execute();

  await db.schema
    .createTable('agents')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('extension_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('max_no_answer', 'integer', (col) => col.notNull().defaultTo(3))
    .addColumn('wrap_up_seconds', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('reject_delay_seconds', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  await db.schema.createIndex('agents_tenant_idx').on('agents').column('tenant_id').execute();
  // One agent identity per extension, per tenant — the same "an extension
  // has at most one of this related-resource kind" shape `sip_credentials`
  // already enforces for extensions themselves.
  await db.schema
    .createIndex('agents_extension_idx')
    .on('agents')
    .column('extension_id')
    .unique()
    .execute();

  await db.schema
    .createTable('queue_tiers')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('queue_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('agent_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('level', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('position', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('queue_tiers_tenant_idx')
    .on('queue_tiers')
    .column('tenant_id')
    .execute();
  await db.schema
    .createIndex('queue_tiers_queue_idx')
    .on('queue_tiers')
    .column('queue_id')
    .execute();
  // An agent tiered into the same queue twice would just be a duplicate
  // `<tier>` row in callcenter.conf — reject it at write time instead.
  await db.schema
    .createIndex('queue_tiers_queue_agent_idx')
    .on('queue_tiers')
    .columns(['queue_id', 'agent_id'])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('queue_tiers').execute();
  await db.schema.dropTable('agents').execute();
  await db.schema.dropTable('queues').execute();
}
