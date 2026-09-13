import type { Migration } from 'kysely/migration';
import type { Kysely } from 'kysely';
import { Type, defineEvents } from '@cuc/api-contracts';

import { createEventTables, type EventTables } from '../../src/schema.js';

/** A service schema: the event tables plus one business table to write with them. */
export interface TestDb extends EventTables {
  extensions: {
    id: string;
    tenant_id: string;
    number: string;
  };
  /** What a consumer's handler writes, so its effects can be counted. */
  handled: {
    id: string;
    event_id: string;
    number: string;
  };
}

export const testEvents = defineEvents({
  'pbx.extension.created': {
    schemaVersion: 1,
    description: 'An extension was created.',
    data: Type.Object({
      extensionId: Type.String({ minLength: 1 }),
      number: Type.String({ minLength: 1 }),
    }),
  },
});

const initial: Migration = {
  async up(db: Kysely<unknown>) {
    await createEventTables(db);

    await db.schema
      .createTable('extensions')
      .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
      .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
      .addColumn('number', 'varchar(32)', (col) => col.notNull())
      .execute();

    await db.schema
      .createTable('handled')
      .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
      .addColumn('event_id', 'varchar(36)', (col) => col.notNull())
      .addColumn('number', 'varchar(32)', (col) => col.notNull())
      .execute();
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('handled').execute();
    await db.schema.dropTable('extensions').execute();
    await db.schema.dropTable('consumed_events').execute();
    await db.schema.dropTable('outbox').execute();
  },
};

export const testMigrations: Record<string, Migration> = {
  '20260101000000_initial': initial,
};
