import { sql, type Kysely } from 'kysely';

/**
 * Reset and invitation tokens are issued when the email is sent, not when the
 * reset or invitation is created (G-55). The row now exists before any token
 * does, so `token_hash` is nullable: NULL until notification-service asks for
 * the link, then the SHA-256 of the one token that works. Issuing again
 * replaces the hash, which is what invalidates the earlier token.
 *
 * Compatible expansion only: every existing row keeps its hash, so a link
 * emailed before the upgrade still works until it expires. The unique indexes
 * stay; MariaDB allows any number of NULLs in a unique index.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('password_reset_tokens')
    .modifyColumn('token_hash', 'varchar(64)')
    .execute();
  await db.schema.alterTable('invitations').modifyColumn('token_hash', 'varchar(64)').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // A row whose link was never issued has nothing to restore, and nobody can
  // have used it.
  await sql`delete from password_reset_tokens where token_hash is null`.execute(db);
  await sql`delete from invitations where token_hash is null`.execute(db);
  await db.schema
    .alterTable('password_reset_tokens')
    .modifyColumn('token_hash', 'varchar(64)', (col) => col.notNull())
    .execute();
  await db.schema
    .alterTable('invitations')
    .modifyColumn('token_hash', 'varchar(64)', (col) => col.notNull())
    .execute();
}
