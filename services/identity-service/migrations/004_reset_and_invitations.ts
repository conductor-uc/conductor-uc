import type { Kysely } from 'kysely';

/**
 * Password reset and invitation tokens (06: `POST /v1/auth/password-reset`,
 * invitations). Only the SHA-256 of a token is stored, like refresh tokens:
 * a read-only copy of these tables cannot be replayed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('password_reset_tokens')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('user_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('token_hash', 'varchar(64)', (col) => col.notNull())
    .addColumn('expires_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('used_at', 'datetime(3)')
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addForeignKeyConstraint('password_reset_tokens_user_fk', ['user_id'], 'users', ['id'])
    .execute();
  await db.schema
    .createIndex('password_reset_tokens_hash_idx')
    .on('password_reset_tokens')
    .column('token_hash')
    .unique()
    .execute();

  await db.schema
    .createTable('invitations')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('org_id', 'varchar(36)', (col) => col.notNull())
    // The inviter's own org type and reseller, snapshotted for the same reason
    // `users` snapshots them: identity-service holds no org read model.
    .addColumn('org_type', 'varchar(16)', (col) => col.notNull())
    .addColumn('reseller_id', 'varchar(36)')
    .addColumn('email', 'varchar(255)', (col) => col.notNull())
    .addColumn('display_name', 'varchar(255)', (col) => col.notNull())
    .addColumn('invited_by', 'varchar(36)')
    .addColumn('token_hash', 'varchar(64)', (col) => col.notNull())
    .addColumn('expires_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('accepted_at', 'datetime(3)')
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .execute();
  await db.schema
    .createIndex('invitations_hash_idx')
    .on('invitations')
    .column('token_hash')
    .unique()
    .execute();
  await db.schema.createIndex('invitations_org_idx').on('invitations').column('org_id').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('invitations').execute();
  await db.schema.dropTable('password_reset_tokens').execute();
}
