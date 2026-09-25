#!/usr/bin/env node
import * as path from 'node:path';

import { fileKekFromConfig } from '@cuc/crypto';
import { createDatabase, migrateToLatest } from '@cuc/db';
import { createLogger, toLogLevel } from '@cuc/logger';

import { loadServiceConfig } from '../config.js';
import { createSigningKeyRepo } from '../repo/signing-key.repo.js';
import type { IdentityServiceDb } from '../schema.js';
import { parseRotateSigningKeyArgs, ROTATE_SIGNING_KEY_USAGE } from './rotate-signing-key-args.js';

let args;
try {
  args = parseRotateSigningKeyArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
  process.stderr.write(ROTATE_SIGNING_KEY_USAGE);
  process.exit(2);
}

if (args.help) {
  process.stdout.write(ROTATE_SIGNING_KEY_USAGE);
} else {
  await main(args.revokePrevious);
}

async function main(revokePrevious: boolean): Promise<void> {
  const config = loadServiceConfig();
  const logger = createLogger({
    name: 'identity-service-rotate-signing-key',
    level: toLogLevel(process.env['LOG_LEVEL']),
  });

  const db = createDatabase<IdentityServiceDb>({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_NAME,
    connectTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
    logger,
  });

  try {
    // Brings the schema to this image's version (the `revoked_at` column) in
    // case the command runs before the service itself was started on it.
    await migrateToLatest({
      db: db.kysely,
      // dist/src/cli/rotate-signing-key.js -> dist/migrations.
      dir: path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'migrations'),
      logger,
    });

    const repo = createSigningKeyRepo(db, fileKekFromConfig(config));
    const result = await repo.rotateNow({ revokePrevious });

    logger.info(
      {
        previousKeyId: result.previousKeyId,
        keyId: result.current.id,
        revoked: result.revoked,
        overlapDays: config.SIGNING_KEY_OVERLAP_DAYS,
      },
      revokePrevious
        ? 'signing key rotated; every earlier key revoked and removed from the JWKS'
        : 'signing key rotated; the previous key stays in the JWKS for SIGNING_KEY_OVERLAP_DAYS',
    );
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      'signing key rotation failed; the signing key was not rotated',
    );
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}
