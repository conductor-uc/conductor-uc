import type { Kysely } from 'kysely';

/**
 * S2-04: everything the outbound-to-PSTN dialplan branch needs beyond
 * S2-01/S2-02's trunk mirror.
 *
 * `tenants.country` is nullable and back-filled lazily, the same
 * self-healing story `002_add_extension_number.ts` already tells for
 * `extensions.number`: `org.consumer.ts`'s `org.tenant.created` handler
 * fetches it from org-service at creation time (`src/org-client.ts`), and a
 * row from before this migration simply has no country until the next
 * `reconcile.ts` pass or a real `org.tenant.updated` re-fetch (neither
 * exists yet for country specifically — a gap, docs/decisions.md).
 *
 * `tenant_dr_groups` is a separate table, not a column on `tenants`: a
 * `drouting` `dr_rules.groupid` is a plain `INT`, and OpenSIPs' own script
 * needs a *stable, small* per-tenant integer to pass explicitly to
 * `do_routing()` — MariaDB's `AUTO_INCREMENT` on its own dedicated
 * single-purpose table is the simplest way to hand out one, without
 * touching `tenants`' own primary key (`id`, a UUID) at all.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('tenants').addColumn('country', 'varchar(2)').execute();

  await db.schema
    .createTable('tenant_dr_groups')
    .addColumn('dr_group_id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .execute();
  await db.schema
    .createIndex('tenant_dr_groups_tenant_idx')
    .on('tenant_dr_groups')
    .column('tenant_id')
    .unique()
    .execute();

  await db.schema.alterTable('extensions').addColumn('caller_id_name', 'varchar(255)').execute();
  await db.schema.alterTable('extensions').addColumn('caller_id_number', 'varchar(32)').execute();

  // Flattened from trunk-service's `{name, number}` `caller_id_policy`
  // (G-22) — S2-04's caller-ID precedence, third tier.
  await db.schema.alterTable('trunks').addColumn('caller_id_name', 'varchar(255)').execute();
  await db.schema.alterTable('trunks').addColumn('caller_id_number', 'varchar(32)').execute();

  // The local mirror of trunk-service's `outbound_routes` (05 §3.4) —
  // `trunk_ids` is a JSON array, the same shape as trunk-service's own
  // column (`outbound-route.repo.ts`'s own comment on the driver-parsing
  // quirk this incurs).
  await db.schema
    .createTable('outbound_routes')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('priority', 'integer', (col) => col.notNull())
    .addColumn('pattern', 'varchar(32)', (col) => col.notNull())
    .addColumn('trunk_ids', 'json', (col) => col.notNull())
    .addColumn('strip', 'integer', (col) => col.notNull())
    .addColumn('prepend', 'varchar(32)')
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .execute();
  await db.schema
    .createIndex('outbound_routes_tenant_idx')
    .on('outbound_routes')
    .column('tenant_id')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('outbound_routes').execute();
  await db.schema.alterTable('trunks').dropColumn('caller_id_number').execute();
  await db.schema.alterTable('trunks').dropColumn('caller_id_name').execute();
  await db.schema.alterTable('extensions').dropColumn('caller_id_number').execute();
  await db.schema.alterTable('extensions').dropColumn('caller_id_name').execute();
  await db.schema.dropTable('tenant_dr_groups').execute();
  await db.schema.alterTable('tenants').dropColumn('country').execute();
}
