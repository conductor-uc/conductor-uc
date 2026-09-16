import type { Kysely } from 'kysely';

/**
 * S2-07 (05 §3.3): `media_assets` — tenant-uploaded prompts/MOH/greetings.
 * `status` tracks the upload -> finalize -> transcode lifecycle
 * (`domain/media-asset.ts`'s own state machine); `variant_8k_key`/
 * `variant_16k_key` stay null until a separate transcode worker (S2-07's own
 * isolation choice — untrusted, tenant-uploaded audio is parsed by `ffmpeg`
 * in its own service, never in this one) reports success.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('media_assets')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('kind', 'varchar(16)', (col) => col.notNull())
    .addColumn('label', 'varchar(255)', (col) => col.notNull())
    .addColumn('status', 'varchar(16)', (col) => col.notNull().defaultTo('pending'))
    .addColumn('content_type', 'varchar(128)', (col) => col.notNull())
    .addColumn('object_key', 'varchar(512)', (col) => col.notNull())
    .addColumn('variant_8k_key', 'varchar(512)')
    .addColumn('variant_16k_key', 'varchar(512)')
    .addColumn('duration_ms', 'integer')
    .addColumn('sha256', 'varchar(64)')
    .addColumn('size_bytes', 'integer')
    .addColumn('error_message', 'text')
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  await db.schema
    .createIndex('media_assets_tenant_idx')
    .on('media_assets')
    .column('tenant_id')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('media_assets').execute();
}
