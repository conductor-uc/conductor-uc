import type { Kysely } from 'kysely';

/**
 * S2-04: outbound routes (05 §3.4).
 *
 * Every migration is backward compatible with the previous service version:
 * expand now, contract later (CLAUDE.md rule 7 / 09 §6.7).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('outbound_routes')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('priority', 'integer', (col) => col.notNull())
    .addColumn('pattern', 'varchar(32)', (col) => col.notNull())
    .addColumn('trunk_ids', 'json', (col) => col.notNull())
    .addColumn('strip', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('prepend', 'varchar(32)')
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  // Every tenant-owned table leads its index with tenant_id (05 §2.1); what
  // the outbound-dial lookup (this service's own route list, and
  // telephony-config's local mirror once projected) filters by first.
  await db.schema
    .createIndex('outbound_routes_tenant_idx')
    .on('outbound_routes')
    .column('tenant_id')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('outbound_routes').execute();
}
