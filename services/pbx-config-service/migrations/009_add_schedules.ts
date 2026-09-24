import type { Kysely } from 'kysely';

/**
 * S3-08 (05 §3.3): a schedule is a tenant's open hours. `rules` is a list of
 * weekly windows and `holidays` a list of dates the windows do not apply to;
 * `domain/schedule.ts` says what each holds. Both are JSON because they are
 * always read and written whole, never queried by field.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('schedules')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('label', 'varchar(255)', (col) => col.notNull())
    .addColumn('timezone', 'varchar(64)', (col) => col.notNull())
    .addColumn('rules', 'json', (col) => col.notNull())
    .addColumn('holidays', 'json', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .execute();

  await db.schema.createIndex('schedules_tenant_idx').on('schedules').column('tenant_id').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('schedules').execute();
}
