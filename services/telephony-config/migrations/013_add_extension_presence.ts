import type { Kysely } from 'kysely';

/**
 * S5-10 (G-122): the presence this service last announced for each extension: whether a phone
 * is registered for it (OpenSIPs' `usrloc`) and whether it is set to do not disturb (its call
 * handling). The presence watcher compares each poll with these rows and announces only the
 * extensions that changed, in the same transaction as the change (the outbox). Purely additive.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('extension_presence')
    .addColumn('extension_id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('registered', 'boolean', (col) => col.notNull())
    .addColumn('dnd', 'boolean', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .execute();
  await db.schema
    .createIndex('extension_presence_tenant')
    .on('extension_presence')
    .column('tenant_id')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('extension_presence').execute();
}
