import type { Kysely } from 'kysely';

/**
 * S1-08 (G-14, 05's `api_keys`): a key belongs to one org and carries an
 * explicit permission list, capped at what its creator held. The key itself is
 * `key_<id>_<secret>`: `id` (12 hex characters, the part shown in lists and
 * logs) finds the row, and only a SHA-256 of the secret is stored, so the key
 * cannot be recovered from the database. `expires_at` is optional (the
 * owner's G-14 decision); `revoked_at` ends a key for good.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('api_keys')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('org_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('org_type', 'varchar(16)', (col) => col.notNull())
    .addColumn('reseller_id', 'varchar(36)')
    .addColumn('name', 'varchar(128)', (col) => col.notNull())
    .addColumn('prefix', 'varchar(16)', (col) => col.notNull().unique())
    .addColumn('secret_hash', 'varchar(64)', (col) => col.notNull())
    /** JSON array of permission names. */
    .addColumn('permissions', 'text', (col) => col.notNull())
    .addColumn('created_by', 'varchar(36)', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('expires_at', 'datetime(3)')
    .addColumn('last_used_at', 'datetime(3)')
    .addColumn('revoked_at', 'datetime(3)')
    .execute();
  await db.schema.createIndex('api_keys_org_idx').on('api_keys').column('org_id').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('api_keys').execute();
}
