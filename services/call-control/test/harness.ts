import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import type { Logger } from '@cuc/logger';
import {
  silentLogger,
  startTestDatabase,
  startTestRedis,
  type TestRedisHandle,
} from '@cuc/testing';
import { Redis } from 'ioredis';

import { createCallRegistry, type CallRegistry } from '../src/redis/registry.js';
import type { CallControlDb } from '../src/schema.js';
import { migrations } from '../migrations/index.js';

export interface Harness {
  readonly db: Database<CallControlDb>;
  readonly redis: Redis;
  readonly registry: CallRegistry;
  readonly keyPrefix: string;
  readonly logger: Logger;
  close(): Promise<void>;
}

/** A migrated schema plus a real Redis, key-prefixed per test for isolation on a shared server (`TestRedisHandle`'s own doc comment on why). */
export async function startHarness(): Promise<Harness> {
  const logger = silentLogger();
  const dbHandle = await startTestDatabase();
  const redisHandle: TestRedisHandle = await startTestRedis();

  const db = createDatabase<CallControlDb>({
    host: dbHandle.host,
    port: dbHandle.port,
    user: dbHandle.user,
    password: dbHandle.password,
    database: dbHandle.database,
    poolSize: 4,
    logger,
  });
  await migrateToLatest({ db: db.kysely, migrations, logger });

  const redis = new Redis(redisHandle.url, { lazyConnect: false, maxRetriesPerRequest: 2 });
  const registry = createCallRegistry(redis, redisHandle.keyPrefix);

  return {
    db,
    redis,
    registry,
    keyPrefix: redisHandle.keyPrefix,
    logger,
    async close() {
      await db.destroy();
      await dbHandle.stop();
      redis.disconnect();
      await redisHandle.stop();
    },
  };
}

export async function resetSchema(db: Database<CallControlDb>): Promise<void> {
  await db.kysely.deleteFrom('outbox').execute();
  await db.kysely.deleteFrom('consumed_events').execute();
}
