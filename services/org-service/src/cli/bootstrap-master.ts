#!/usr/bin/env node
import * as path from 'node:path';
import { parseArgs } from 'node:util';

import { createLogger, toLogLevel } from '@cuc/logger';
import { createDatabase, migrateToLatest } from '@cuc/db';

import { loadServiceConfig } from '../config.js';
import { createOrgRepo, MasterAlreadyExistsError } from '../repo/org.repo.js';
import type { OrgServiceDb } from '../schema.js';

const USAGE = `Usage: bootstrap-master --slug <slug> --name <name>

Creates the single master org for this deployment (02 §1). Never run through
an API — this is the one place a master row is created, and it is meant to
run once.

The master's first admin user is created through identity-service's internal
API, which does not exist until S1-05. This command creates the org only and
prints what still needs doing.

Options:
  --slug <slug>   Lowercase DNS label, 2-63 characters (default: master)
  --name <name>   Display name (default: Master)
  --help
`;

const { values } = parseArgs({
  options: {
    slug: { type: 'string', default: 'master' },
    name: { type: 'string', default: 'Master' },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  process.stdout.write(USAGE);
  process.exitCode = 0;
} else {
  await main();
}

async function main(): Promise<void> {
  const config = loadServiceConfig();
  const logger = createLogger({
    name: 'org-service-bootstrap',
    level: toLogLevel(process.env['LOG_LEVEL']),
  });

  const db = createDatabase<OrgServiceDb>({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_NAME,
    connectTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
    logger,
  });

  try {
    await migrateToLatest({
      db: db.kysely,
      // dist/src/cli/bootstrap-master.js -> dist/migrations.
      dir: path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'migrations'),
      logger,
    });

    const repo = createOrgRepo(db, { platformBaseDomain: config.PLATFORM_BASE_DOMAIN });

    try {
      const master = await repo.createMaster({ slug: values.slug, name: values.name });
      logger.info({ orgId: master.id, slug: master.slug }, 'master org created');
      logger.warn(
        'The master has no admin user yet: identity-service does not exist ' +
          'until S1-05. Create one manually once it does.',
      );
    } catch (error) {
      if (error instanceof MasterAlreadyExistsError) {
        logger.info('master org already exists; nothing to do');
        process.exitCode = 0;
        return;
      }
      throw error;
    }
  } finally {
    await db.destroy();
  }
}
