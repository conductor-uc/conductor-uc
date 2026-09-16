import type { Kysely } from 'kysely';

/**
 * S2-03: the local mirror of pbx-config-service's `dids` (05 §3, `src/schema.ts`'s
 * own incremental-growth pattern) — what `/fs/dialplan`'s from-trunk lookup
 * resolves against. `e164` is not marked unique here the way pbx-config-service's
 * own `dids_e164_idx` is: this is a read model kept in sync by events, not the
 * source of truth that enforces the real constraint.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('dids')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('e164', 'varchar(20)', (col) => col.notNull())
    .addColumn('trunk_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('destination_type', 'varchar(16)', (col) => col.notNull())
    .addColumn('destination_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .execute();

  // What `/fs/dialplan`'s from-trunk lookup queries by (03 §3.2).
  await db.schema
    .createIndex('dids_tenant_e164_idx')
    .on('dids')
    .columns(['tenant_id', 'e164'])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('dids').execute();
}
