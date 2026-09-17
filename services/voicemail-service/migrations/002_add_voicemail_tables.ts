import type { Kysely } from 'kysely';

/**
 * S2-16 (05 §3.3-style layout, 06's voicemail-service section):
 * `mailboxes` (PIN, greeting) and `messages` (per-message metadata).
 * `messages.status` is `pending` (spool upload not yet confirmed) ->
 * `ready` | `failed` — no `processing` state, unlike media assets: there is
 * no transcode step here (07's Lua app records straight to a playable WAV).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('mailboxes')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('extension_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('pin_enc', 'text', (col) => col.notNull())
    .addColumn('greeting_status', 'varchar(16)', (col) => col.notNull().defaultTo('none'))
    .addColumn('greeting_object_key', 'varchar(512)')
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  await db.schema.createIndex('mailboxes_tenant_idx').on('mailboxes').column('tenant_id').execute();
  // One mailbox per extension, per tenant (06: "Mailbox lookup" is always by extension).
  await db.schema
    .createIndex('mailboxes_tenant_extension_idx')
    .on('mailboxes')
    .columns(['tenant_id', 'extension_id'])
    .unique()
    .execute();

  await db.schema
    .createTable('messages')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('mailbox_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('status', 'varchar(16)', (col) => col.notNull().defaultTo('pending'))
    .addColumn('object_key', 'varchar(512)', (col) => col.notNull())
    .addColumn('caller_id_name', 'varchar(128)')
    .addColumn('caller_id_number', 'varchar(64)')
    .addColumn('duration_ms', 'integer')
    .addColumn('size_bytes', 'integer')
    .addColumn('is_read', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  await db.schema.createIndex('messages_tenant_idx').on('messages').column('tenant_id').execute();
  await db.schema
    .createIndex('messages_mailbox_idx')
    .on('messages')
    .columns(['mailbox_id', 'created_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('messages').execute();
  await db.schema.dropTable('mailboxes').execute();
}
