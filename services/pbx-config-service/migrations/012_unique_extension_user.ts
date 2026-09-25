import type { Kysely } from 'kysely';

/**
 * End-user self-service (parity 1e): `extensions.user_id` says which person an
 * extension belongs to, and the person's own portal finds their extension by
 * it. That only works if a person has at most one extension per tenant, so it
 * is unique within a tenant. A NULL (an extension nobody is linked to, the
 * common case) never collides with another NULL.
 *
 * The column has existed since 001 and nothing read it, so a tenant that
 * filled it in twice for the same person would fail this migration; there is
 * no such data in any environment this ships to, and silently unlinking one of
 * two extensions would be worse than stopping.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex('extensions_tenant_user_idx')
    .on('extensions')
    .columns(['tenant_id', 'user_id'])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('extensions_tenant_user_idx').on('extensions').execute();
}
