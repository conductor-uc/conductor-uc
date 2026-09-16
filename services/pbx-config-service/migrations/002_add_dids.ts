import type { Kysely } from 'kysely';

/**
 * S2-03: DIDs (05 §3.3: "`dids` | `id`, `tenant_id`, `e164` (globally
 * unique), `trunk_id`, `destination_type`, `destination_id`, `sms_enabled`,
 * `fax_enabled`").
 *
 * `sms_enabled`/`fax_enabled` are deliberately not added yet — the same
 * "only the columns this task gives meaning to" discipline `001_initial.ts`
 * already applies to `extensions`' own `forwarding`/`dnd`/`max_concurrent`:
 * nothing in scope through S2-03 (sms-service is S7-03, fax-service is
 * S7-01) reads or writes them. A later migration is a compatible expansion.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('dids')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('e164', 'varchar(20)', (col) => col.notNull())
    .addColumn('trunk_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('destination_type', 'varchar(16)', (col) => col.notNull())
    .addColumn('destination_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  // A DID is a real phone number: globally unique, not just per tenant (05
  // §3.3's own wording, unlike `extensions.number`, which 001_initial.ts
  // scopes per tenant).
  await db.schema.createIndex('dids_e164_idx').on('dids').column('e164').unique().execute();

  // Every tenant-owned table leads its index with tenant_id (05 §2.1) — what
  // `scoped(ctx)` list/lookup queries filter by first.
  await db.schema.createIndex('dids_tenant_idx').on('dids').column('tenant_id').execute();

  // `route{}`'s from-trunk case (03 §2.1) rejects a DID that arrives on a
  // trunk other than the one it's bound to — this is the index that check runs on.
  await db.schema.createIndex('dids_trunk_idx').on('dids').column('trunk_id').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('dids').execute();
}
