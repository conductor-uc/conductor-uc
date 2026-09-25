import { sql, type QueryExecutorProvider } from 'kysely';
import type { Logger } from '@cuc/logger';

/**
 * One envelope-encrypted column: the table, its primary key, and the column
 * holding the ciphertext. Nullable columns are fine; `NULL` is skipped.
 */
export interface RewrapTarget {
  readonly table: string;
  /** A single-column primary key. Batches walk it in order. */
  readonly idColumn: string;
  readonly column: string;
}

/**
 * What the job needs from the encryption package — `@cuc/crypto`'s
 * `kekRewrapper(kek)` has exactly this shape. It is declared here rather than
 * imported so `@cuc/db` does not depend on `@cuc/crypto`.
 */
export interface CiphertextRewrapper {
  /** What every encrypted value starts with, whatever its key version. */
  readonly formatPrefix: string;
  /** What a value under the current key version starts with. */
  currentPrefix(): string;
  /** Rewraps a value under the current key version. Must not need the value's associated data. */
  rewrap(ciphertext: string): Promise<string>;
}

export interface RewrapJobOptions {
  /**
   * The connection to work on. For a service with tenant-owned tables this is
   * `db.unscoped(ctx, reason)`: the job spans every tenant by design.
   */
  readonly db: QueryExecutorProvider;
  readonly targets: readonly RewrapTarget[];
  readonly rewrapper: CiphertextRewrapper;
  readonly logger: Logger;
  /** Rows read and rewrapped per query. Default 100. */
  readonly batchSize?: number;
}

export interface RewrapResult {
  /** Values moved to the current key version in this pass. */
  readonly rewrapped: number;
  /** Values another writer changed first; they are no longer this pass's concern. */
  readonly skipped: number;
  /** Values that could not be rewrapped (their old key version is missing, say). */
  readonly failed: number;
  /** Values still under an older key version after the pass. */
  readonly remaining: number;
}

const DEFAULT_BATCH_SIZE = 100;

/** How often services run a re-wrap pass: every 10 minutes, after one at startup. */
export const REWRAP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Re-wraps envelope-encrypted values still under an older KEK version, in the
 * background (G-116), so an old version can eventually leave `CRYPTO_KEKS`.
 *
 * Safe to run in several copies of a service at once, and idempotent:
 *
 * - Each value is replaced only if it is still exactly what was read
 *   (`UPDATE … WHERE id = ? AND col = <old value>`), so a concurrent copy doing
 *   the same row, or an application write of a new value, simply wins; the
 *   loser's update matches nothing and is counted as skipped.
 * - The rewrap changes only the wrapped data key, not the payload, so both
 *   copies' results decrypt to the same value under the same associated data.
 * - Nothing holds a lock or a transaction across batches.
 *
 * Rows are found by prefix in SQL (the key version sits at a fixed place at
 * the start of every value), compared as bytes because base64url is
 * case-sensitive and the column's collation may not be. Each table is walked
 * in primary-key order, so a value that fails to rewrap is passed over for the
 * rest of the pass instead of being retried in a loop.
 */
export function createRewrapJob(options: RewrapJobOptions) {
  const { db, targets, rewrapper, logger } = options;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  let timer: NodeJS.Timeout | undefined;
  let running: Promise<RewrapResult> | undefined;
  let lastRemaining: number | undefined;

  /** SQL predicate: an encrypted value not under the current version. */
  function underOlderVersion(target: RewrapTarget, currentPrefix: string) {
    const column = sql.ref(target.column);
    return sql`${column} is not null
      and cast(left(${column}, ${rewrapper.formatPrefix.length}) as binary) = cast(${rewrapper.formatPrefix} as binary)
      and cast(left(${column}, ${currentPrefix.length}) as binary) <> cast(${currentPrefix} as binary)`;
  }

  async function countRemaining(currentPrefix: string): Promise<number> {
    let total = 0;
    for (const target of targets) {
      const { rows } = await sql<{ n: number | string }>`
        select count(*) as n from ${sql.table(target.table)}
        where ${underOlderVersion(target, currentPrefix)}`.execute(db);
      total += Number(rows[0]?.n ?? 0);
    }
    return total;
  }

  async function rewrapTarget(
    target: RewrapTarget,
    currentPrefix: string,
  ): Promise<Omit<RewrapResult, 'remaining'>> {
    const id = sql.ref(target.idColumn);
    const column = sql.ref(target.column);
    let rewrapped = 0;
    let skipped = 0;
    let failed = 0;
    let after: string | undefined;

    for (;;) {
      const { rows } = await sql<{ id: string; value: string }>`
        select ${id} as id, ${column} as value from ${sql.table(target.table)}
        where ${underOlderVersion(target, currentPrefix)}
        ${after === undefined ? sql`` : sql`and ${id} > ${after}`}
        order by ${id}
        limit ${batchSize}`.execute(db);
      if (rows.length === 0) break;

      for (const row of rows) {
        let next: string;
        try {
          next = await rewrapper.rewrap(row.value);
        } catch (error) {
          failed += 1;
          // Never the value: it is a secret, even wrapped.
          logger.warn(
            {
              table: target.table,
              column: target.column,
              id: row.id,
              err: error instanceof Error ? error.message : String(error),
            },
            'kek re-wrap: could not re-wrap a value; it stays under its old key version',
          );
          continue;
        }

        const result = await sql`
          update ${sql.table(target.table)} set ${column} = ${next}
          where ${id} = ${row.id}
            and cast(${column} as binary) = cast(${row.value} as binary)`.execute(db);
        if (Number(result.numAffectedRows ?? 0) === 1) rewrapped += 1;
        else skipped += 1;
      }

      after = rows[rows.length - 1]!.id;
      if (rows.length < batchSize) break;
    }

    return { rewrapped, skipped, failed };
  }

  async function pass(): Promise<RewrapResult> {
    const currentPrefix = rewrapper.currentPrefix();
    let rewrapped = 0;
    let skipped = 0;
    let failed = 0;

    for (const target of targets) {
      const result = await rewrapTarget(target, currentPrefix);
      rewrapped += result.rewrapped;
      skipped += result.skipped;
      failed += result.failed;
    }

    const remaining = await countRemaining(currentPrefix);
    const previous = lastRemaining;
    lastRemaining = remaining;

    if (remaining > 0) {
      logger.warn(
        { rewrapped, skipped, failed, remaining },
        `kek re-wrap: ${String(remaining)} values under older key versions`,
      );
    } else if (previous === undefined || previous > 0 || rewrapped > 0) {
      logger.info(
        { rewrapped, skipped },
        'kek re-wrap: every value is under the current key version; older versions can be removed',
      );
    }
    return { rewrapped, skipped, failed, remaining };
  }

  /** One pass over every target. Concurrent calls in this process share one pass. */
  function runOnce(): Promise<RewrapResult> {
    running ??= pass().finally(() => {
      running = undefined;
    });
    return running;
  }

  function runLogged(): void {
    runOnce().catch((error: unknown) => {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'kek re-wrap: pass failed; will retry on the next one',
      );
    });
  }

  return {
    runOnce,

    /** The count from the last completed pass, or `undefined` before the first. */
    remaining(): number | undefined {
      return lastRemaining;
    },

    /**
     * For `app.addReadinessCheck('kek_rewrap', job.readinessCheck)`. Always
     * passes: values under an older version are still readable, so this is
     * information for whoever wants to retire that version, not unreadiness.
     */
    readinessCheck: (): Promise<{ status: 'pass'; detail: string }> =>
      Promise.resolve({
        status: 'pass',
        detail:
          lastRemaining === undefined
            ? 'not checked yet'
            : `${String(lastRemaining)} values under older key versions`,
      }),

    /** A pass now (in the background) and then every `intervalMs`. */
    start(intervalMs: number): void {
      runLogged();
      timer = setInterval(runLogged, intervalMs);
      timer.unref();
    },

    /** Stops the timer and waits for a pass in progress, so shutdown can close the pool after. */
    async stop(): Promise<void> {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await running?.catch(() => undefined);
    },
  };
}

export type RewrapJob = ReturnType<typeof createRewrapJob>;
