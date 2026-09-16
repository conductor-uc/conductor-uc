import type { Kysely } from 'kysely';

/**
 * S2-02: the local mirror of trunk-service's trunks (05 §3, `src/schema.ts`'s
 * own incremental-growth pattern). Only the columns the `registrant`/
 * `address`/`dr_gateways`/`dr_groups` projection actually needs — not the
 * fuller shape trunk-service owns (codecs, caller-ID policy, max_channels
 * have no reader here).
 *
 * `trunk_ips` mirrors trunk-service's own child table (1:N — a single flat
 * row per trunk, like `extensions`, cannot represent this), since the
 * `address` table needs one row per CIDR, not per trunk.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('trunks')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('name', 'varchar(255)', (col) => col.notNull())
    .addColumn('auth_mode', 'varchar(16)', (col) => col.notNull())
    .addColumn('host', 'varchar(255)', (col) => col.notNull())
    .addColumn('port', 'integer', (col) => col.notNull())
    .addColumn('transport', 'varchar(16)', (col) => col.notNull())
    .addColumn('username', 'varchar(128)')
    .addColumn('secret', 'text')
    .addColumn('from_domain', 'varchar(255)')
    .addColumn('status', 'varchar(32)', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .execute();

  await db.schema.createIndex('trunks_tenant_idx').on('trunks').column('tenant_id').execute();

  await db.schema
    .createTable('trunk_ips')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('trunk_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('cidr', 'varchar(64)', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .execute();

  await db.schema.createIndex('trunk_ips_trunk_idx').on('trunk_ips').column('trunk_id').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('trunk_ips').execute();
  await db.schema.dropTable('trunks').execute();
}
