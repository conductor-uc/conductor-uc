import type { Kysely } from 'kysely';

/**
 * S2-08: the local mirror of pbx-config-service's `ring_groups` (05 §3, the
 * same "local read model on the call-setup hot path" story `004_add_dids.ts`
 * already tells) — what `/fs/dialplan`'s from-trunk lookup resolves against
 * when a DID's `destination_type` is `ring_group`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('ring_groups')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('label', 'varchar(255)', (col) => col.notNull())
    .addColumn('strategy', 'varchar(16)', (col) => col.notNull())
    .addColumn('member_extension_ids', 'text', (col) => col.notNull())
    .addColumn('ring_timeout_seconds', 'integer', (col) => col.notNull())
    .addColumn('no_answer_destination_type', 'varchar(16)')
    .addColumn('no_answer_destination_id', 'varchar(36)')
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('ring_groups_tenant_idx')
    .on('ring_groups')
    .column('tenant_id')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('ring_groups').execute();
}
