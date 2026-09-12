import { Kysely, MysqlDialect, sql, type LogEvent } from 'kysely';
import { createPool, type Pool } from 'mysql2';
import type { Logger } from '@cuc/logger';

import type { DbContext } from './context.js';
import { scopedFor, type ScopedDb } from './scoped.js';
import { loggingUnscopedSink, unscopedFor, type UnscopedAccessSink } from './unscoped.js';

export interface DatabaseOptions {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly poolSize?: number;
  readonly connectTimeoutMs?: number;
  readonly logger: Logger;
  /**
   * Where cross-tenant accesses are reported. Defaults to a `warn` log line;
   * `@cuc/audit` replaces it with the audit stream.
   */
  readonly onUnscopedAccess?: UnscopedAccessSink;
}

/**
 * A service's handle on its own schema.
 *
 * `kysely` is the unscoped escape hatch and is deliberately awkward to reach:
 * the lint rule in the repository's ESLint config forbids raw SQL outside
 * migrations and this package, and tenant-owned tables go through `scoped`.
 */
export interface Database<DB> {
  /** Tenant-scoped access. The only way to read tenant-owned tables. */
  scoped(ctx: DbContext): ScopedDb<DB>;
  /** Cross-tenant access, with a mandatory reason that is audited. */
  unscoped(ctx: DbContext, reason: string): Kysely<DB>;
  /** For migrations, schema introspection, and non-tenant tables. */
  readonly kysely: Kysely<DB>;
  /** `SELECT 1`, for `GET /readyz`. */
  ping(): Promise<boolean>;
  destroy(): Promise<void>;
}

/**
 * Opens the connection pool and returns the service's database handle.
 *
 * Slow queries are logged at `warn` with their duration; every query is logged
 * at `debug`. Neither logs parameters, because they carry SIP secrets and
 * password hashes (09 §4).
 */
export function createDatabase<DB>(options: DatabaseOptions): Database<DB> {
  const { logger, onUnscopedAccess } = options;

  const pool: Pool = createPool({
    host: options.host,
    port: options.port,
    user: options.user,
    password: options.password,
    database: options.database,
    connectionLimit: options.poolSize ?? 10,
    connectTimeout: options.connectTimeoutMs ?? 10_000,
    // UUIDv7 primary keys are generated in the application (05 §1.2), and
    // DATETIME(3) values are handled as UTC strings rather than local Dates.
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: false,
    dateStrings: false,
  });

  const db = new Kysely<DB>({
    dialect: new MysqlDialect({ pool }),
    log: (event: LogEvent) => logQuery(logger, event),
  });

  const sink = onUnscopedAccess ?? loggingUnscopedSink(logger);

  return {
    kysely: db,
    scoped: (ctx) => scopedFor(db, ctx),
    unscoped: (ctx, reason) => unscopedFor(db, ctx, reason, sink),

    async ping() {
      try {
        await sql`select 1`.execute(db);
        return true;
      } catch (error) {
        logger.error({ err: error }, 'database ping failed');
        return false;
      }
    },

    destroy: () => db.destroy(),
  };
}

const SLOW_QUERY_MS = 200;

function logQuery(logger: Logger, event: LogEvent): void {
  const durationMs = Math.round(event.queryDurationMillis);

  if (event.level === 'error') {
    logger.error({ err: event.error, durationMs, sql: event.query.sql }, 'query failed');
    return;
  }
  if (durationMs >= SLOW_QUERY_MS) {
    logger.warn({ durationMs, sql: event.query.sql }, 'slow query');
    return;
  }
  logger.debug({ durationMs, sql: event.query.sql }, 'query');
}
