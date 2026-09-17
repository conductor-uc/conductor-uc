import type { Kysely } from 'kysely';

/**
 * S2-08 (05 §3.3): `ring_groups` — a DID destination that fans a call out to
 * several extensions per a ring strategy (`domain/ring-group.ts`'s own enum).
 * `member_extension_ids` is a JSON array of `extensions.id`, in ring order —
 * the same ordered-list-as-JSON choice trunk-service's own `outbound_routes.
 * trunk_ids` already made (S2-04).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('ring_groups')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('label', 'varchar(255)', (col) => col.notNull())
    .addColumn('strategy', 'varchar(16)', (col) => col.notNull())
    .addColumn('member_extension_ids', 'json', (col) => col.notNull())
    .addColumn('ring_timeout_seconds', 'integer', (col) => col.notNull())
    .addColumn('no_answer_destination_type', 'varchar(16)')
    .addColumn('no_answer_destination_id', 'varchar(36)')
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
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
