#!/usr/bin/env node
import * as path from 'node:path';
import { parseArgs } from 'node:util';

import { createLogger, toLogLevel } from '@cuc/logger';
import { loadConfig, Type } from '@cuc/config';

import { createDatabase } from './client.js';
import { dbEnvSchema } from './config.js';
import {
  createMigration,
  migrateDown,
  migrateToLatest,
  migrateToNothing,
  migrateUp,
  migrationStatus,
} from './migrate.js';

const USAGE = `Usage: cuc-db <command> [options]

Commands:
  latest              Apply every pending migration
  up                  Apply the next pending migration
  down                Revert the most recent migration (development only)
  reset --confirm     Revert every migration
  status              List migrations and whether they have run
  create <name>       Write a new timestamped migration file

Options:
  --dir <path>        Migrations folder (default: ./migrations)
  --help

Connection settings come from the environment: DB_HOST, DB_PORT, DB_USER,
DB_PASSWORD, DB_NAME. Migrations are the only place raw SQL is allowed.
`;

const cliSchema = Type.Object({
  ...dbEnvSchema.properties,
  LOG_LEVEL: Type.Optional(Type.String()),
});

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      dir: { type: 'string' },
      confirm: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  const [command, ...rest] = positionals;

  if (values.help || command === undefined) {
    process.stdout.write(USAGE);
    return command === undefined && !values.help ? 1 : 0;
  }

  const dir = path.resolve(values.dir ?? 'migrations');
  const logger = createLogger({
    name: 'db-migrate',
    level: toLogLevel(process.env['LOG_LEVEL']),
  });

  // `create` writes a file and needs no database, so it runs before config is
  // validated. Everything else connects.
  if (command === 'create') {
    const name = rest.join(' ');
    if (name === '') {
      logger.error('create needs a name, for example: cuc-db create add_extensions');
      return 1;
    }
    logger.info({ file: await createMigration(dir, name) }, 'migration created');
    return 0;
  }

  const config = loadConfig(cliSchema);
  const database = createDatabase({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_NAME,
    connectTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
    logger,
  });
  const options = { db: database.kysely, dir, logger };

  try {
    switch (command) {
      case 'latest':
        await migrateToLatest(options);
        return 0;
      case 'up':
        await migrateUp(options);
        return 0;
      case 'down':
        await migrateDown(options);
        return 0;
      case 'reset':
        await migrateToNothing({ ...options, confirm: values.confirm });
        return 0;
      case 'status': {
        for (const migration of await migrationStatus(options)) {
          const state =
            migration.executedAt === undefined
              ? 'pending'
              : `applied ${migration.executedAt.toISOString()}`;
          process.stdout.write(`${migration.name.padEnd(48)} ${state}\n`);
        }
        return 0;
      }
      default:
        logger.error({ command }, 'unknown command');
        process.stdout.write(USAGE);
        return 1;
    }
  } finally {
    await database.destroy();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // The logger may not exist yet if config validation threw, so this path
    // writes to stderr directly.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
