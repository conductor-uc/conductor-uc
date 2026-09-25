import type { Kysely } from 'kysely';

/**
 * S5-01/S5-04/S5-05 (05 §3-style layout, 06's recording-service section):
 * policies, recording metadata, and the per-tenant retention setting.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('recording_policies')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('scope_type', 'varchar(16)', (col) => col.notNull())
    .addColumn('scope_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('direction', 'varchar(16)', (col) => col.notNull().defaultTo('any'))
    .addColumn('action', 'varchar(16)', (col) => col.notNull())
    .addColumn('announce', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('consent_asset_id', 'varchar(36)')
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  // One policy per scope and direction: a second one would be a tie with nothing to break it.
  await db.schema
    .createIndex('recording_policies_scope_idx')
    .on('recording_policies')
    .columns(['tenant_id', 'scope_type', 'scope_id', 'direction'])
    .unique()
    .execute();

  await db.schema
    .createTable('recordings')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('call_uuid', 'varchar(64)', (col) => col.notNull())
    .addColumn('extension_id', 'varchar(36)')
    .addColumn('peer_extension_id', 'varchar(36)')
    .addColumn('queue_id', 'varchar(36)')
    .addColumn('did_id', 'varchar(36)')
    .addColumn('direction', 'varchar(16)', (col) => col.notNull())
    .addColumn('policy_id', 'varchar(36)')
    .addColumn('node_id', 'varchar(64)')
    .addColumn('announced', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('status', 'varchar(16)', (col) => col.notNull().defaultTo('pending'))
    .addColumn('object_key', 'varchar(512)', (col) => col.notNull())
    .addColumn('content_type', 'varchar(64)', (col) => col.notNull())
    .addColumn('started_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('duration_ms', 'integer')
    .addColumn('size_bytes', 'bigint')
    .addColumn('sha256', 'varchar(64)')
    .addColumn('failure_reason', 'varchar(128)')
    .addColumn('retention_date', 'datetime(3)')
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  // Tenant-owned tables need an index that leads with tenant_id (05 §2.1).
  await db.schema
    .createIndex('recordings_tenant_started_idx')
    .on('recordings')
    .columns(['tenant_id', 'started_at'])
    .execute();
  await db.schema
    .createIndex('recordings_call_idx')
    .on('recordings')
    .columns(['tenant_id', 'call_uuid'])
    .execute();
  // The retention sweep reads across tenants by date and status.
  await db.schema
    .createIndex('recordings_retention_idx')
    .on('recordings')
    .columns(['status', 'retention_date'])
    .execute();

  await db.schema
    .createTable('recording_settings')
    .addColumn('tenant_id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('retention_days', 'integer', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('recording_settings').execute();
  await db.schema.dropTable('recordings').execute();
  await db.schema.dropTable('recording_policies').execute();
}
