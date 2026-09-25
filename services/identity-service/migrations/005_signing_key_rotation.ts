import { sql, type Kysely } from 'kysely';

/**
 * Signing-key rotation (G-116). Compatible expansion only: two nullable
 * columns, and every existing key keeps doing exactly what it did.
 *
 * - `activated_at`: when the key started signing. `NULL` on a live key means
 *   it is the *next* key, published in the JWKS ahead of use so every
 *   verifier has fetched it before the first token it signs arrives. Existing
 *   keys were active from the moment they were created, so they are backfilled
 *   with `created_at`.
 * - `revoked_at`: set by `rotate-signing-key --revoke-previous`; the key leaves
 *   the JWKS at once instead of when its overlap window ends.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('signing_keys')
    .addColumn('activated_at', 'datetime(3)')
    .addColumn('revoked_at', 'datetime(3)')
    .execute();
  await sql`update signing_keys set activated_at = created_at`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('signing_keys')
    .dropColumn('revoked_at')
    .dropColumn('activated_at')
    .execute();
}
