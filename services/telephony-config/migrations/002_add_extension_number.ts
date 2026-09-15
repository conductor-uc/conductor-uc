import type { Kysely } from 'kysely';

/**
 * S1-13: `/fs/dialplan`'s ext→ext lookup matches on the extension's current
 * dialable `number`, not the frozen SIP `username` `extensions` already
 * carries (`src/schema.ts` explains why the two can diverge). Backfilling
 * existing rows is not attempted — the next `pbx.extension.*` delivery or
 * reconciliation pass re-fetches and fills every row in (`src/projection.ts`,
 * `src/reconcile.ts`), the same self-healing story 001's own tables rely on.
 *
 * Not unique: `pbx-config-service` enforces per-tenant number uniqueness at
 * its own source of truth, but a renumbering swap (A: 101→102, B: 102→101)
 * can transiently collide in this eventually-consistent projection between
 * the two events landing — a plain index is what a *dialplan lookup* needs
 * (fast, `tenant_id` + `number`), not a constraint this projection cannot
 * honestly enforce.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('extensions')
    .addColumn('number', 'varchar(64)', (col) => col.notNull().defaultTo(''))
    .execute();

  await db.schema
    .createIndex('extensions_tenant_number_idx')
    .on('extensions')
    .columns(['tenant_id', 'number'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('extensions_tenant_number_idx').execute();
  await db.schema.alterTable('extensions').dropColumn('number').execute();
}
