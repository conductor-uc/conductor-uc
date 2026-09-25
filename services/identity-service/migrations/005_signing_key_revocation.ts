import type { Kysely } from 'kysely';

/**
 * `signing_keys.revoked_at` (G-116): set by `rotate-signing-key
 * --revoke-previous` on every retired key, which drops it from the JWKS at
 * once instead of at the end of its overlap window. For a suspected leak.
 * Compatible expansion only: a nullable column, and nothing existing changes.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('signing_keys').addColumn('revoked_at', 'datetime(3)').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('signing_keys').dropColumn('revoked_at').execute();
}
