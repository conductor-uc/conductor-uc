import type { Kysely } from 'kysely';

/**
 * S2-13: the local mirror of pbx-config-service's `queues`/`agents`/
 * `queue_tiers` (05 §3, the same "local read model on the call-setup hot
 * path" story `007_add_ring_groups.ts` already tells) — what `/fs/dialplan`'s
 * from-trunk `queue` branch and `/fs/configuration`'s `callcenter.conf`
 * builder both resolve against.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('queues')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('label', 'varchar(255)', (col) => col.notNull())
    .addColumn('strategy', 'varchar(32)', (col) => col.notNull())
    .addColumn('moh_media_asset_id', 'varchar(36)')
    .addColumn('max_wait_seconds', 'integer', (col) => col.notNull())
    .addColumn('announce_position', 'boolean', (col) => col.notNull())
    .addColumn('announce_frequency_seconds', 'integer')
    .addColumn('no_agent_destination_type', 'varchar(16)')
    .addColumn('no_agent_destination_id', 'varchar(36)')
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .execute();

  await db.schema.createIndex('queues_tenant_idx').on('queues').column('tenant_id').execute();

  await db.schema
    .createTable('agents')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('extension_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('max_no_answer', 'integer', (col) => col.notNull())
    .addColumn('wrap_up_seconds', 'integer', (col) => col.notNull())
    .addColumn('reject_delay_seconds', 'integer', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .execute();

  await db.schema.createIndex('agents_tenant_idx').on('agents').column('tenant_id').execute();
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
    .addColumn('level', 'integer', (col) => col.notNull())
    .addColumn('position', 'integer', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('queue_tiers_queue_idx')
    .on('queue_tiers')
    .column('queue_id')
    .execute();
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
