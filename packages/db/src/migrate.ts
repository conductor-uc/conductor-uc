import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { Kysely } from 'kysely';
import {
  FileMigrationProvider,
  Migrator,
  NO_MIGRATIONS,
  type Migration,
  type MigrationProvider,
  type MigrationResult,
} from 'kysely/migration';
import type { Logger } from '@cuc/logger';

/**
 * Where migrations come from. Exactly one of the two must be given.
 *
 * `dir` is the deployment path: the container runs the compiled
 * `dist/migrations/*.js`, and `cuc-db` points at that folder.
 *
 * `migrations` is an explicit manifest of statically imported modules. It exists
 * because a directory scan bottoms out in Node's own `import()`, which cannot
 * load TypeScript — so a `.ts` migration is unreachable from a test runner or a
 * plain `node` process. A manifest is also the only form in which a migration
 * list can be reviewed in a diff.
 */
export interface MigrationSource {
  readonly dir?: string;
  readonly migrations?: Readonly<Record<string, Migration>>;
}

export interface MigrateOptions<DB> extends MigrationSource {
  readonly db: Kysely<DB>;
  readonly logger: Logger;
}

/** Thrown when a migration fails, after the successful ones are reported. */
export class MigrationFailedError extends Error {
  override readonly name = 'MigrationFailedError';
  readonly results: readonly MigrationResult[];

  constructor(cause: unknown, results: readonly MigrationResult[]) {
    super(`Migration failed: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.results = results;
  }
}

/** A provider over an explicit manifest, applied in sorted name order. */
export function manifestMigrationProvider(
  migrations: Readonly<Record<string, Migration>>,
): MigrationProvider {
  return {
    getMigrations: () =>
      Promise.resolve(
        Object.fromEntries(Object.entries(migrations).sort(([a], [b]) => a.localeCompare(b))),
      ),
  };
}

function providerFor(source: MigrationSource): MigrationProvider {
  const hasDir = source.dir !== undefined;
  const hasManifest = source.migrations !== undefined;

  if (hasDir === hasManifest) {
    throw new Error(
      'Pass exactly one migration source: `dir` for a folder of compiled ' +
        'migrations, or `migrations` for a statically imported manifest.',
    );
  }
  if (source.migrations !== undefined) return manifestMigrationProvider(source.migrations);

  return new FileMigrationProvider({ fs, path, migrationFolder: source.dir! });
}

function migratorFor<DB>(options: MigrateOptions<DB>): Migrator {
  return new Migrator({ db: options.db, provider: providerFor(options) });
}

function report(logger: Logger, results: readonly MigrationResult[] | undefined): void {
  for (const result of results ?? []) {
    const fields = { migration: result.migrationName, direction: result.direction };
    if (result.status === 'Success') logger.info(fields, 'migration applied');
    else if (result.status === 'Error') logger.error(fields, 'migration failed');
    else logger.warn(fields, 'migration not executed');
  }
}

/**
 * Applies every pending migration.
 *
 * Kysely's migrator holds a lock for the duration, so several service instances
 * starting at once is safe: one migrates and the others wait.
 */
export async function migrateToLatest<DB>(
  options: MigrateOptions<DB>,
): Promise<readonly MigrationResult[]> {
  const { error, results } = await migratorFor(options).migrateToLatest();
  report(options.logger, results);
  if (error !== undefined) throw new MigrationFailedError(error, results ?? []);
  if ((results ?? []).length === 0) options.logger.info('no pending migrations');
  return results ?? [];
}

/** Applies the next pending migration only. */
export async function migrateUp<DB>(
  options: MigrateOptions<DB>,
): Promise<readonly MigrationResult[]> {
  const { error, results } = await migratorFor(options).migrateUp();
  report(options.logger, results);
  if (error !== undefined) throw new MigrationFailedError(error, results ?? []);
  return results ?? [];
}

/**
 * Reverts the most recent migration.
 *
 * Rule 7 asks for expand-then-contract, so `down` is a development convenience.
 * A deployed contraction is a new forward migration, not a rollback.
 */
export async function migrateDown<DB>(
  options: MigrateOptions<DB>,
): Promise<readonly MigrationResult[]> {
  const { error, results } = await migratorFor(options).migrateDown();
  report(options.logger, results);
  if (error !== undefined) throw new MigrationFailedError(error, results ?? []);
  return results ?? [];
}

/** Reverts every migration. Refuses to run unless `confirm` is true. */
export async function migrateToNothing<DB>(
  options: MigrateOptions<DB> & { readonly confirm: boolean },
): Promise<readonly MigrationResult[]> {
  if (!options.confirm) {
    throw new Error('migrateToNothing drops every migrated object; pass confirm: true.');
  }
  const { error, results } = await migratorFor(options).migrateTo(NO_MIGRATIONS);
  report(options.logger, results);
  if (error !== undefined) throw new MigrationFailedError(error, results ?? []);
  return results ?? [];
}

export interface MigrationStatus {
  readonly name: string;
  readonly executedAt: Date | undefined;
}

/** Lists every migration and whether it has run. */
export async function migrationStatus<DB>(
  options: MigrateOptions<DB>,
): Promise<readonly MigrationStatus[]> {
  const migrations = await migratorFor(options).getMigrations();
  return migrations.map((migration) => ({
    name: migration.name,
    executedAt: migration.executedAt,
  }));
}

/**
 * Creates an empty timestamped migration.
 *
 * The name is prefixed with UTC `YYYYMMDDHHmmss` so migrations sort in the order
 * they were written, which is the order Kysely applies them.
 */
export async function createMigration(dir: string, name: string): Promise<string> {
  const slug = name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '');

  if (slug === '') throw new Error('A migration name must contain at least one letter or digit.');

  const stamp = new Date().toISOString().replaceAll(/[-:T]/g, '').slice(0, 14);
  const file = path.join(dir, `${stamp}_${slug}.ts`);

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, MIGRATION_TEMPLATE, { flag: 'wx' });
  return file;
}

const MIGRATION_TEMPLATE = `import type { Kysely } from 'kysely';

/**
 * Every migration must be backward compatible with the previous service version:
 * expand now, contract in a later migration once nothing reads the old shape
 * (CLAUDE.md rule 7 / 09 §6.7).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // await db.schema.createTable('…')
  //   .addColumn('id', 'uuid', (col) => col.primaryKey())
  //   .addColumn('tenant_id', 'uuid', (col) => col.notNull())
  //   .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
  //   .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
  //   .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
  //   .execute();
  //
  // Tenant-owned tables need an index that leads with tenant_id (05 §2.1):
  // await db.schema.createIndex('…_tenant_idx').on('…').columns(['tenant_id', '…']).execute();
  void db;
}

export async function down(db: Kysely<unknown>): Promise<void> {
  void db;
}
`;
