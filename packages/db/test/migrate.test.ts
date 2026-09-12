import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Migration } from 'kysely/migration';
import type { Kysely } from 'kysely';
import { databaseOrSkipReason } from '@cuc/testing';

import {
  createMigration,
  manifestMigrationProvider,
  migrateDown,
  migrateToLatest,
  migrateToNothing,
  migrateUp,
  migrationStatus,
} from '../src/migrate.js';
import { captureLogger } from './helpers.js';
import { openTestDatabase, type TestDatabase } from './test-database.js';

const skipReason = await databaseOrSkipReason();

interface EmptyDb {
  first_table: { id: string };
  second_table: { id: string };
}

const first: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('first_table')
      .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
      .execute();
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('first_table').execute();
  },
};

const second: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('second_table')
      .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
      .execute();
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('second_table').execute();
  },
};

const failing: Migration = {
  up() {
    return Promise.reject(new Error('deliberate migration failure'));
  },
  down() {
    return Promise.resolve();
  },
};

describe('manifestMigrationProvider', () => {
  it('applies migrations in sorted name order, not insertion order', async () => {
    const provider = manifestMigrationProvider({
      '20260102000000_second': second,
      '20260101000000_first': first,
    });

    expect(Object.keys(await provider.getMigrations())).toEqual([
      '20260101000000_first',
      '20260102000000_second',
    ]);
  });
});

describe('migration source', () => {
  it('refuses both a folder and a manifest', async () => {
    const { logger } = captureLogger();

    await expect(
      migrationStatus({ db: {} as Kysely<unknown>, logger, dir: '/tmp', migrations: {} }),
    ).rejects.toThrow(/exactly one migration source/);
  });

  it('refuses neither', async () => {
    const { logger } = captureLogger();

    await expect(migrationStatus({ db: {} as Kysely<unknown>, logger })).rejects.toThrow(
      /exactly one migration source/,
    );
  });
});

describe.skipIf(skipReason !== undefined)('migration runner', () => {
  let database: TestDatabase<EmptyDb>;

  beforeAll(async () => {
    database = await openTestDatabase<EmptyDb>({});
  });

  afterAll(async () => {
    await database?.close();
  });

  afterEach(async () => {
    const { logger } = captureLogger();
    await migrateToNothing({
      db: database.db.kysely,
      logger,
      migrations: { '20260101000000_first': first, '20260102000000_second': second },
      confirm: true,
    });
  });

  const migrations = { '20260101000000_first': first, '20260102000000_second': second };

  async function tables(): Promise<string[]> {
    const all = await database.db.kysely.introspection.getTables();
    return all.map((table) => table.name).sort();
  }

  it('applies every pending migration', async () => {
    const { logger } = captureLogger();

    const results = await migrateToLatest({ db: database.db.kysely, logger, migrations });

    expect(results.map((result) => result.migrationName)).toEqual([
      '20260101000000_first',
      '20260102000000_second',
    ]);
    expect(await tables()).toContain('first_table');
    expect(await tables()).toContain('second_table');
  });

  it('is a no-op when nothing is pending', async () => {
    const { lines, logger } = captureLogger();
    await migrateToLatest({ db: database.db.kysely, logger, migrations });

    const results = await migrateToLatest({ db: database.db.kysely, logger, migrations });

    expect(results).toEqual([]);
    expect(lines.some((line) => line['msg'] === 'no pending migrations')).toBe(true);
  });

  it('applies one migration at a time with up', async () => {
    const { logger } = captureLogger();

    await migrateUp({ db: database.db.kysely, logger, migrations });

    expect(await tables()).toContain('first_table');
    expect(await tables()).not.toContain('second_table');
  });

  it('reverts the most recent migration with down', async () => {
    const { logger } = captureLogger();
    await migrateToLatest({ db: database.db.kysely, logger, migrations });

    await migrateDown({ db: database.db.kysely, logger, migrations });

    expect(await tables()).toContain('first_table');
    expect(await tables()).not.toContain('second_table');
  });

  it('reports which migrations have run', async () => {
    const { logger } = captureLogger();
    await migrateUp({ db: database.db.kysely, logger, migrations });

    const status = await migrationStatus({ db: database.db.kysely, logger, migrations });

    expect(status).toHaveLength(2);
    expect(status[0]!.executedAt).toBeInstanceOf(Date);
    expect(status[1]!.executedAt).toBeUndefined();
  });

  it('throws on a failing migration, after reporting the successful ones', async () => {
    const { logger } = captureLogger();

    await expect(
      migrateToLatest({
        db: database.db.kysely,
        logger,
        migrations: { '20260101000000_first': first, '20260102000000_boom': failing },
      }),
    ).rejects.toThrow(/deliberate migration failure/);

    // The migration that succeeded stays applied: MariaDB has no transactional
    // DDL, so a partial run is the real behaviour and must be visible.
    expect(await tables()).toContain('first_table');
  });

  it('refuses to revert everything without confirmation', async () => {
    const { logger } = captureLogger();

    await expect(
      migrateToNothing({ db: database.db.kysely, logger, migrations, confirm: false }),
    ).rejects.toThrow(/confirm: true/);
  });
});

describe('createMigration', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cuc-migrations-'));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes a UTC-timestamped file so migrations sort in write order', async () => {
    const file = await createMigration(dir, 'add extensions table');

    expect(path.basename(file)).toMatch(/^\d{14}_add_extensions_table\.ts$/);
  });

  it('scaffolds up and down, and points at expand-then-contract', async () => {
    const file = await createMigration(dir, 'second');
    const content = await fs.readFile(file, 'utf8');

    expect(content).toContain('export async function up');
    expect(content).toContain('export async function down');
    expect(content).toContain('expand now, contract in a later migration');
    expect(content).toContain('tenant_id');
  });

  it('rejects a name with nothing usable in it', async () => {
    await expect(createMigration(dir, '   ---   ')).rejects.toThrow(/at least one letter or digit/);
  });
});
