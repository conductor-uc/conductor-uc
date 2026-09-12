import type { Migration } from 'kysely/migration';
import type { Kysely } from 'kysely';

/** A tenant-owned table and a platform table, to exercise both paths. */
export interface TestDb {
  widgets: {
    id: string;
    tenant_id: string;
    label: string;
    version: number;
  };
  /** No `tenant_id`: `scoped` must refuse it at compile time. */
  platform_settings: {
    key: string;
    value: string;
  };
}

const initial: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('widgets')
      .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
      .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
      .addColumn('label', 'varchar(128)', (col) => col.notNull())
      .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
      .execute();
    await db.schema
      .createIndex('widgets_tenant_idx')
      .on('widgets')
      .columns(['tenant_id', 'label'])
      .execute();
    await db.schema
      .createTable('platform_settings')
      .addColumn('key', 'varchar(64)', (col) => col.primaryKey())
      .addColumn('value', 'varchar(255)', (col) => col.notNull())
      .execute();
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('widgets').execute();
    await db.schema.dropTable('platform_settings').execute();
  },
};

export const testMigrations: Record<string, Migration> = {
  '20260101000000_initial': initial,
};
