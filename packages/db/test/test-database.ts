import type { Migration } from 'kysely/migration';
import { silentLogger, startTestDatabase, type TestDatabaseHandle } from '@cuc/testing';

import { createDatabase, type Database } from '../src/client.js';
import { migrateToLatest } from '../src/migrate.js';

export interface TestDatabase<DB> {
  readonly db: Database<DB>;
  readonly handle: TestDatabaseHandle;
  close(): Promise<void>;
}

/**
 * A freshly migrated schema plus a `@cuc/db` handle on it.
 *
 * `@cuc/testing` deliberately does not depend on `@cuc/db` — the dependency runs
 * the other way, so this package can use the container helper in its own tests
 * without a workspace cycle. The wiring is three lines, which is why it lives
 * here rather than being hidden behind a helper.
 */
export async function openTestDatabase<DB>(
  migrations: Record<string, Migration>,
): Promise<TestDatabase<DB>> {
  const logger = silentLogger();
  const handle = await startTestDatabase();

  const db = createDatabase<DB>({
    host: handle.host,
    port: handle.port,
    user: handle.user,
    password: handle.password,
    database: handle.database,
    poolSize: 4,
    logger,
  });

  await migrateToLatest({ db: db.kysely, migrations, logger });

  return {
    db,
    handle,
    async close() {
      await db.destroy();
      await handle.stop();
    },
  };
}
