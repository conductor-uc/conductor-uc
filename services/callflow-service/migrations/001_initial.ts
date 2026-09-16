import type { Kysely } from 'kysely';

import { createEventTables } from '@cuc/events';

/**
 * Every migration is backward compatible with the previous service version:
 * expand now, contract later, once nothing reads the old shape (CLAUDE.md
 * rule 7 / 09 §6.7).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await createEventTables(db); // outbox + consumed_events

  await db.schema
    .createTable('flows')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('name', 'varchar(128)', (col) => col.notNull())
    .addColumn('draft_graph', 'json', (col) => col.notNull())
    .addColumn('draft_updated_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('current_published_version_id', 'varchar(36)')
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  // Tenant-owned tables need an index that leads with tenant_id (05 §2.1).
  await db.schema
    .createIndex('flows_tenant_idx')
    .on('flows')
    .columns(['tenant_id', 'created_at'])
    .execute();

  // Immutable once written (S2-09's own "a published version cannot be
  // modified" done-when) — `:publish` only ever inserts a new row here,
  // never updates one. `:rollback` only ever repoints
  // flows.current_published_version_id, never touches this table.
  await db.schema
    .createTable('flow_versions')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('flow_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('version_number', 'integer', (col) => col.notNull())
    .addColumn('graph', 'json', (col) => col.notNull())
    .addColumn('ir', 'json', (col) => col.notNull())
    .addColumn('published_at', 'datetime(3)', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('flow_versions_tenant_idx')
    .on('flow_versions')
    .columns(['tenant_id', 'flow_id'])
    .execute();

  await db.schema
    .createIndex('flow_versions_flow_number_idx')
    .on('flow_versions')
    .columns(['flow_id', 'version_number'])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('flow_versions').execute();
  await db.schema.dropTable('flows').execute();
  await db.schema.dropTable('consumed_events').execute();
  await db.schema.dropTable('outbox').execute();
}
