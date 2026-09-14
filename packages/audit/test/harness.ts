import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { connectBus, createEventTables, type Bus, type EventTables } from '@cuc/events';
import type { Logger } from '@cuc/logger';
import { silentLogger, startTestDatabase, startTestNats } from '@cuc/testing';
import type { Migration } from 'kysely/migration';

export interface Harness {
  readonly db: Database<EventTables>;
  readonly bus: Bus;
  readonly logger: Logger;
  close(): Promise<void>;
}

const migrations: Record<string, Migration> = {
  '001_initial': {
    up: createEventTables,
    down: async (db) => {
      await db.schema.dropTable('consumed_events').execute();
      await db.schema.dropTable('outbox').execute();
    },
  },
};

/** A migrated outbox/consumed_events schema plus a JetStream server with streams provisioned. */
export async function startHarness(): Promise<Harness> {
  const logger = silentLogger();
  const dbHandle = await startTestDatabase();
  const natsHandle = await startTestNats();

  const db = createDatabase<EventTables>({
    host: dbHandle.host,
    port: dbHandle.port,
    user: dbHandle.user,
    password: dbHandle.password,
    database: dbHandle.database,
    poolSize: 4,
    logger,
  });
  await migrateToLatest({ db: db.kysely, migrations, logger });

  const bus = await connectBus({ servers: [natsHandle.server], logger, name: 'audit-test' });
  await bus.ensureStreams();

  return {
    db,
    bus,
    logger,
    async close() {
      await bus.close();
      await db.destroy();
      await dbHandle.stop();
      await natsHandle.stop();
    },
  };
}
