import type { Kysely } from 'kysely';

/**
 * S9-07 (D-019): an invitation can name the extension waiting for the person.
 * When they accept, `identity.invitation.accepted` carries it, and
 * pbx-config-service links the extension to their new account, so adding a
 * person in the console never leaves the link as a manual step. Nullable:
 * most invitations name none.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('invitations').addColumn('extension_id', 'varchar(36)').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('invitations').dropColumn('extension_id').execute();
}
