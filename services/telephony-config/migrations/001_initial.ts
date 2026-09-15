import type { Kysely } from 'kysely';

import { createEventTables } from '@cuc/events';

/**
 * S1-12: the read model behind the `opensips` schema projection (05 §3,
 * 06's telephony-config section).
 *
 * `outbox` exists for `EventTables` conformance (`@cuc/events`' consumers
 * require it structurally) but this service never publishes anything —
 * 06 lists no events telephony-config emits — so nothing ever inserts into
 * it and no relay runs against it (`src/main.ts`).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await createEventTables(db); // outbox + consumed_events

  await db.schema
    .createTable('tenants')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('status', 'varchar(16)', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .execute();

  await db.schema
    .createTable('domains')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('fqdn', 'varchar(255)', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .execute();

  // At most one current primary domain per tenant (02 §3).
  await db.schema
    .createIndex('domains_tenant_idx')
    .on('domains')
    .column('tenant_id')
    .unique()
    .execute();

  await db.schema
    .createTable('extensions')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('username', 'varchar(64)', (col) => col.notNull())
    .addColumn('ha1', 'char(32)', (col) => col.notNull())
    .addColumn('realm', 'varchar(255)', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('extensions_tenant_idx')
    .on('extensions')
    .column('tenant_id')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('extensions').execute();
  await db.schema.dropTable('domains').execute();
  await db.schema.dropTable('tenants').execute();
  await db.schema.dropTable('consumed_events').execute();
  await db.schema.dropTable('outbox').execute();
}
