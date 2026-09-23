import type { Kysely } from 'kysely';

/**
 * S2-15 (05 §3.3; 03 §3): conference rooms for `mod_conference`. A room is a
 * pinned resource (04 §3.3's `kind: 'conf'`) the same way a queue or
 * parking lot is — one lease per room, one node's memory at a time.
 *
 * `pin_enc` is envelope-encrypted (07 §5: "Envelope encryption protects ...
 * conference PINs"), same as `sip_credentials.secret_enc` — see
 * `repo/conference-room.repo.ts`'s own use of `@cuc/crypto`. Null means no
 * PIN is required to join.
 *
 * `video` records tenant intent only — `mod_vpx` is not in this image's
 * module set (`modules.conf.xml`'s own comment: "M1 is audio-only; video
 * arrives with S6-01"), so a room with `video: true` behaves identically to
 * one without until that stage.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('conference_rooms')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('label', 'varchar(255)', (col) => col.notNull())
    .addColumn('number', 'varchar(16)', (col) => col.notNull())
    .addColumn('pin_enc', 'text')
    .addColumn('video', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('layout', 'varchar(32)')
    .addColumn('max_members', 'integer', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  await db.schema
    .createIndex('conference_rooms_tenant_idx')
    .on('conference_rooms')
    .column('tenant_id')
    .execute();
  await db.schema
    .createIndex('conference_rooms_tenant_number_idx')
    .on('conference_rooms')
    .columns(['tenant_id', 'number'])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('conference_rooms').execute();
}
