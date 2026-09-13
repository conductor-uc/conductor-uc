import { randomUUID } from 'node:crypto';

import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { silentLogger, startTestDatabase, startTestNats } from '@cuc/testing';
import type { TestDatabaseHandle, TestNatsHandle } from '@cuc/testing';
import type { Logger } from '@cuc/logger';

import { connectBus, type Bus } from '../src/bus.js';
import { testMigrations, type TestDb } from './fixtures/schema.js';

export interface Harness {
  readonly db: Database<TestDb>;
  readonly bus: Bus;
  readonly logger: Logger;
  readonly dbHandle: TestDatabaseHandle;
  readonly natsHandle: TestNatsHandle;
  /** A fresh bus on the same server, for the relay-restart test. */
  newBus(name: string): Promise<Bus>;
  close(): Promise<void>;
}

/** A migrated schema plus a JetStream server with the streams provisioned. */
export async function startHarness(): Promise<Harness> {
  const logger = silentLogger();
  const dbHandle = await startTestDatabase();
  const natsHandle = await startTestNats();

  const db = createDatabase<TestDb>({
    host: dbHandle.host,
    port: dbHandle.port,
    user: dbHandle.user,
    password: dbHandle.password,
    database: dbHandle.database,
    poolSize: 4,
    logger,
  });
  await migrateToLatest({ db: db.kysely, migrations: testMigrations, logger });

  const buses: Bus[] = [];
  const newBus = async (name: string): Promise<Bus> => {
    const bus = await connectBus({ servers: [natsHandle.server], logger, name });
    buses.push(bus);
    return bus;
  };

  const bus = await newBus('harness');
  await bus.ensureStreams();

  return {
    db,
    bus,
    logger,
    dbHandle,
    natsHandle,
    newBus,
    async close() {
      for (const open of buses) {
        try {
          await open.close();
        } catch {
          // Already drained by a test; nothing to do.
        }
      }
      await db.destroy();
      await dbHandle.stop();
      await natsHandle.stop();
    },
  };
}

/** Seeds one extension and its outbox row in a single transaction. */
export async function createExtension(
  harness: Harness,
  tenantId: string,
  number: string,
): Promise<{ extensionId: string; eventId: string }> {
  const { enqueueEvent } = await import('../src/outbox.js');
  const { testEvents } = await import('./fixtures/schema.js');

  const extensionId = randomUUID();

  const eventId = await harness.db.kysely.transaction().execute(async (trx) => {
    await trx
      .insertInto('extensions')
      .values({ id: extensionId, tenant_id: tenantId, number })
      .execute();

    return enqueueEvent(trx, testEvents, {
      type: 'pbx.extension.created',
      data: { extensionId, number },
      orgContext: { tenantId },
      actor: { type: 'user', id: 'user-1', orgId: tenantId },
      correlationId: 'req-1',
    });
  });

  return { extensionId, eventId };
}
