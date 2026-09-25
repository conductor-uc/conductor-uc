#!/usr/bin/env node
import * as path from 'node:path';
import { parseArgs } from 'node:util';

import { createLogger, toLogLevel } from '@cuc/logger';
import { createDatabase, migrateToLatest } from '@cuc/db';

import {
  BootstrapAdminError,
  bootstrapMaster,
  BootstrapUsageError,
  MIN_ADMIN_PASSWORD_LENGTH,
  PASSWORD_ENV,
  readAdminPassword,
  validateAdmin,
  type BootstrapAdmin,
} from '../bootstrap-master.js';
import { loadServiceConfig } from '../config.js';
import { createIdentityClient } from '../identity-client.js';
import { createOrgRepo } from '../repo/org.repo.js';
import type { OrgServiceDb } from '../schema.js';

const USAGE = `Usage: bootstrap-master [--slug <slug>] [--name <name>]
                        [--admin-email <email> --admin-name <display name>]

Creates the single master org for this deployment (02 §1) and, with
--admin-email and --admin-name, its first administrator. Never run through an
API: this is the one place a master row is created.

The administrator is created through identity-service's internal API, so
identity-service must be running (IDENTITY_SERVICE_URL, INTERNAL_SERVICE_TOKEN
from org-service's normal settings). The password is never an argument. It is
read from ${PASSWORD_ENV} if that is set, otherwise from standard input:
a prompt that does not echo on a terminal, or the first line of piped input.
At least ${String(MIN_ADMIN_PASSWORD_LENGTH)} characters.

Safe to run again. An existing master org is kept. The administrator is
created only while the master has no users at all; once anyone exists, the
command creates nobody and exits 0. If the master was created but the
administrator was not, running it again creates just the administrator.

Options:
  --slug <slug>                Lowercase DNS label, 2-63 characters (default: master)
  --name <name>                Display name (default: Master)
  --admin-email <email>        The first administrator's email (sign-in name)
  --admin-name <display name>  The first administrator's display name
  --help

Examples:
  ${PASSWORD_ENV}='…' bootstrap-master --admin-email ops@example.net --admin-name 'Platform administrator'
  printf '%s\\n' "$PW" | bootstrap-master --admin-email ops@example.net --admin-name Ops
`;

let values: {
  slug: string;
  name: string;
  'admin-email'?: string | undefined;
  'admin-name'?: string | undefined;
  help: boolean;
};
try {
  ({ values } = parseArgs({
    options: {
      slug: { type: 'string', default: 'master' },
      name: { type: 'string', default: 'Master' },
      'admin-email': { type: 'string' },
      'admin-name': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  }));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
  process.exit(2);
}

if (values.help) {
  process.stdout.write(USAGE);
  process.exitCode = 0;
} else {
  try {
    await main();
  } catch (error) {
    if (error instanceof BootstrapUsageError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
    } else {
      throw error;
    }
  }
}

async function main(): Promise<void> {
  const adminEmail = values['admin-email'];
  const adminName = values['admin-name'];
  if ((adminEmail === undefined) !== (adminName === undefined)) {
    throw new BootstrapUsageError('--admin-email and --admin-name go together.');
  }

  // Everything about the administrator is checked before anything is created.
  let admin: BootstrapAdmin | undefined;
  if (adminEmail !== undefined && adminName !== undefined) {
    admin = validateAdmin({
      email: adminEmail,
      displayName: adminName,
      password: await readAdminPassword({
        env: process.env,
        stdin: process.stdin,
        prompt: process.stderr,
      }),
    });
  }

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

    const identity = createIdentityClient({
      baseUrl: config.IDENTITY_SERVICE_URL,
      internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
    });

    try {
      const result = await bootstrapMaster(
        {
          repo: createOrgRepo(db, { platformBaseDomain: config.PLATFORM_BASE_DOMAIN }),
          createAdminUser: identity.createAdminUser,
        },
        { slug: values.slug, name: values.name, ...(admin === undefined ? {} : { admin }) },
      );

      logger.info(
        { orgId: result.orgId },
        result.masterCreated ? 'master org created' : 'master org already exists',
      );
      switch (result.admin.status) {
        case 'created':
          logger.info(
            { orgId: result.orgId, userId: result.admin.userId },
            'master administrator created',
          );
          break;
        case 'already_present':
          logger.info(
            { orgId: result.orgId },
            'the master already has users; no administrator created',
          );
          break;
        case 'not_requested':
          if (result.masterCreated) {
            logger.warn(
              { orgId: result.orgId },
              'the master has no administrator yet: run this again with --admin-email and --admin-name',
            );
          }
          break;
      }
    } catch (error) {
      if (error instanceof BootstrapAdminError) {
        logger.error({ orgId: error.orgId }, error.message);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  } finally {
    await db.destroy();
  }
}
