import { randomUUID } from 'node:crypto';

// This helper creates and drops whole schemas, which is DDL rather than tenant
// data access, and @cuc/testing deliberately does not depend on @cuc/db (the
// dependency runs the other way so @cuc/db can use this in its own tests).
// eslint-disable-next-line no-restricted-imports
import { createPool } from 'mysql2/promise';

/** Where the test database lives, and how to let it go. */
export interface TestDatabaseHandle {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  /** Drops the schema, and stops the container if this helper started one. */
  stop(): Promise<void>;
}

/**
 * Production runs MariaDB 11.4 LTS (05 §1), so the container matches. A test
 * that passes against a different major is not evidence about production.
 */
const MARIADB_IMAGE = 'mariadb:11.4';

/** Set to `1` in CI so a missing database fails the run instead of skipping it. */
export const REQUIRE_DB_ENV = 'REQUIRE_DB_TESTS';

/** Point this at an already-running server to skip container startup. */
export const DATABASE_URL_ENV = 'TEST_DATABASE_URL';

interface Connection {
  host: string;
  port: number;
  user: string;
  password: string;
}

/**
 * Starts a MariaDB for integration tests, or reuses one.
 *
 * Two paths, because both matter:
 *
 * - `TEST_DATABASE_URL` points at an already-running server — the compose stack
 *   from S0-05, or a local install. No Docker needed and the suite starts in
 *   milliseconds, which is what makes the inner loop usable.
 * - Otherwise a Testcontainers MariaDB is started and shared for the process.
 *
 * Each call creates its own freshly named schema, so suites running in parallel
 * cannot see each other's rows whichever path is taken.
 */
export async function startTestDatabase(): Promise<TestDatabaseHandle> {
  const external = process.env[DATABASE_URL_ENV] ?? '';
  const { connection, stopServer } =
    external === ''
      ? await startContainer()
      : { connection: parseDatabaseUrl(external), stopServer: noop };

  const database = `cuc_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const admin = createPool({ ...connection, connectionLimit: 1 });

  try {
    await admin.query(`create database \`${database}\``);
  } finally {
    await admin.end();
  }

  return {
    ...connection,
    database,
    async stop() {
      const cleanup = createPool({ ...connection, connectionLimit: 1 });
      try {
        await cleanup.query(`drop database if exists \`${database}\``);
      } finally {
        await cleanup.end();
      }
      await stopServer();
    },
  };
}

/**
 * Whether integration tests can run here.
 *
 * Returns a reason when they cannot, so a suite can skip with something a reader
 * can act on rather than a bare `skipped`.
 */
export async function databaseAvailability(): Promise<{ available: boolean; reason?: string }> {
  if ((process.env[DATABASE_URL_ENV] ?? '') !== '') return { available: true };

  const hasDocker = await canReachDocker();
  if (hasDocker) return { available: true };

  return {
    available: false,
    reason:
      `no database available: set ${DATABASE_URL_ENV} (for example ` +
      `mysql://user:password@127.0.0.1:3306) or make a Docker daemon reachable ` +
      `for Testcontainers`,
  };
}

/** True when these tests must not be skipped. */
export function databaseTestsRequired(): boolean {
  return (process.env[REQUIRE_DB_ENV] ?? '') !== '';
}

let sharedContainer: { connection: Connection; stop: () => Promise<void> } | undefined;

async function noop(): Promise<void> {}

async function startContainer(): Promise<{
  connection: Connection;
  stopServer: () => Promise<void>;
}> {
  if (sharedContainer !== undefined) {
    return { connection: sharedContainer.connection, stopServer: noop };
  }

  // Imported lazily so a suite that uses TEST_DATABASE_URL never pays for
  // loading Testcontainers, and so a machine without Docker can still run the
  // unit tests in this package.
  const { MySqlContainer } = await import('@testcontainers/mysql');
  const container = await new MySqlContainer(MARIADB_IMAGE)
    .withUsername('root')
    .withRootPassword('test')
    .start();

  const connection: Connection = {
    host: container.getHost(),
    port: container.getPort(),
    user: 'root',
    password: 'test',
  };
  sharedContainer = { connection, stop: async () => void (await container.stop()) };

  return { connection, stopServer: noop };
}

/** Stops the shared container, if one was started. Call from global teardown. */
export async function stopSharedContainer(): Promise<void> {
  if (sharedContainer === undefined) return;
  const { stop } = sharedContainer;
  sharedContainer = undefined;
  await stop();
}

async function canReachDocker(): Promise<boolean> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('docker', ['info'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** Parses `mysql://user:password@host:port`. The path is ignored. */
export function parseDatabaseUrl(value: string): Connection {
  const url = new URL(value);
  return {
    host: url.hostname,
    port: url.port === '' ? 3306 : Number(url.port),
    user: decodeURIComponent(url.username) === '' ? 'root' : decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

/**
 * The reason integration tests cannot run here, or `undefined` when they can.
 *
 * Throws when {@link REQUIRE_DB_ENV} is set, so a CI runner with a broken
 * database fails the build instead of reporting a green run full of skips:
 *
 * ```ts
 * const skipReason = await databaseOrSkipReason();
 * describe.skipIf(skipReason !== undefined)('repository', () => { ... });
 * ```
 */
export async function databaseOrSkipReason(): Promise<string | undefined> {
  const { available, reason } = await databaseAvailability();
  if (available) return undefined;

  if (databaseTestsRequired()) {
    throw new Error(`${REQUIRE_DB_ENV} is set, but ${reason ?? 'no database is available'}.`);
  }
  return reason;
}
