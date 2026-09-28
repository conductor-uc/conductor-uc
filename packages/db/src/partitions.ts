import { sql, type Kysely } from 'kysely';
import type { Logger } from '@cuc/logger';

/**
 * One table partitioned by month with `RANGE COLUMNS` on a date column, the
 * shape `audit_events` (identity-service 003) and `cdrs` (cdr-service 002) are
 * created with: `p_before`, one `p_YYYY_MM` per month (values less than the
 * first day of the next month), and `p_max` (values less than `MAXVALUE`).
 */
export interface MonthlyPartitionTarget {
  readonly table: string;
  /** Whole months kept after the month a row falls in ends (G-12, G-52). */
  readonly retentionMonths: number;
}

/** A partition as `information_schema.partitions` describes it. */
export interface ExistingPartition {
  readonly name: string;
  /** The first day it no longer holds (`YYYY-MM-DD`), or null for `MAXVALUE`. */
  readonly upperBound: string | null;
}

export interface PartitionPlan {
  /** Months to add, in order, split out of the `MAXVALUE` partition. */
  readonly add: readonly { readonly name: string; readonly upperBound: string }[];
  /** Partitions whose every row is past retention. */
  readonly drop: readonly string[];
}

export interface PartitionResult {
  readonly table: string;
  readonly added: readonly string[];
  readonly dropped: readonly string[];
  /** Another copy of the service held the table's lock, so this pass left it alone. */
  readonly skipped: boolean;
}

export interface PartitionJobOptions {
  /** The service's own connection; the job spans every tenant by design. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any schema: the job only runs DDL and reads information_schema
  readonly db: Kysely<any>;
  readonly targets: readonly MonthlyPartitionTarget[];
  readonly logger: Logger;
  /** Months ahead of the current one that always have their own partition. Default 3. */
  readonly aheadMonths?: number;
  readonly now?: () => Date;
}

/** How often services run a partition pass: every 6 hours, after one at startup. */
export const PARTITION_INTERVAL_MS = 6 * 60 * 60 * 1000;

const DEFAULT_AHEAD_MONTHS = 3;

function firstOfMonth(year: number, monthIndex: number): Date {
  return new Date(Date.UTC(year, monthIndex, 1));
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `p_2026_09` for the month that ends at `upperBound` (the 1st of October). */
function monthName(upperBound: Date): string {
  const month = firstOfMonth(upperBound.getUTCFullYear(), upperBound.getUTCMonth() - 1);
  return `p_${String(month.getUTCFullYear())}_${String(month.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * What a pass does to one table (S2-21, G-12, G-52), worked out from its
 * partitions and the date alone:
 *
 * - **Add** a partition for every month up to `aheadMonths` after the current
 *   one that does not have its own yet, so rows never pile up in `p_max`.
 * - **Drop** every partition whose rows all ended at least `retentionMonths`
 *   whole months before the start of the current month: with 13 months, on
 *   any day of September 2026, July 2025 and earlier go, and August 2025 stays.
 *   A row is therefore kept for at least its retention, and at most one month
 *   more. `p_max` is never dropped.
 */
export function planMonthlyPartitions(
  existing: readonly ExistingPartition[],
  now: Date,
  retentionMonths: number,
  aheadMonths: number = DEFAULT_AHEAD_MONTHS,
): PartitionPlan {
  if (!Number.isInteger(retentionMonths) || retentionMonths < 1) {
    throw new RangeError('retentionMonths must be a whole number of months, at least 1');
  }
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  const cutoff = day(firstOfMonth(year, month - retentionMonths));
  const drop = existing
    .filter((p) => p.upperBound !== null && p.upperBound <= cutoff)
    .map((p) => p.name);

  const bounds = existing.flatMap((p) => (p.upperBound === null ? [] : [p.upperBound])).sort();
  const highest = bounds.at(-1);
  const add: { name: string; upperBound: string }[] = [];
  for (let i = 1; i <= aheadMonths + 1; i++) {
    const upper = firstOfMonth(year, month + i);
    if (highest !== undefined && day(upper) <= highest) continue;
    add.push({ name: monthName(upper), upperBound: day(upper) });
  }
  return { add, drop };
}

/**
 * Keeps monthly partitions rolling on every target table: the months ahead are
 * added and the months past retention dropped (S2-21). Dropping a partition is
 * how rows past retention leave: instant, whatever the row count, with no
 * long-running delete.
 *
 * Safe to run in several copies of a service at once: each table is worked on
 * under a MariaDB named lock (`GET_LOCK`, not waited for), and a pass that
 * finds it taken leaves that table to the copy holding it. Idempotent: a
 * second pass finds nothing to do.
 */
export function createPartitionJob(options: PartitionJobOptions) {
  const { db, targets, logger } = options;
  const aheadMonths = options.aheadMonths ?? DEFAULT_AHEAD_MONTHS;
  const now = options.now ?? (() => new Date());
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<PartitionResult[]> | undefined;
  let last: PartitionResult[] | undefined;

  for (const target of targets) {
    // Fails at startup rather than on the first pass.
    planMonthlyPartitions([], now(), target.retentionMonths, aheadMonths);
  }

  async function partitionsOf(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as `db` above
    conn: Kysely<any>,
    table: string,
  ): Promise<ExistingPartition[] | undefined> {
    const { rows } = await sql<{ name: string | null; description: string | null }>`
      select partition_name as name, partition_description as description
      from information_schema.partitions
      where table_schema = database() and table_name = ${table}
      order by partition_ordinal_position`.execute(conn);
    if (rows.length === 0 || rows[0]!.name === null) return undefined;
    return rows.map((row) => {
      const description = (row.description ?? '').replace(/'/g, '');
      return {
        name: row.name!,
        upperBound: /^MAXVALUE$/i.test(description) ? null : description.slice(0, 10),
      };
    });
  }

  async function maintain(target: MonthlyPartitionTarget): Promise<PartitionResult> {
    const { table } = target;
    const lock = `partitions:${table}`;
    return db.connection().execute(async (conn) => {
      const { rows } = await sql<{ held: number | string | null }>`
        select get_lock(${lock}, 0) as held`.execute(conn);
      if (Number(rows[0]?.held ?? 0) !== 1) {
        return { table, added: [], dropped: [], skipped: true };
      }
      try {
        const existing = await partitionsOf(conn, table);
        if (existing === undefined) {
          logger.warn({ table }, 'partitions: the table is not partitioned; nothing to maintain');
          return { table, added: [], dropped: [], skipped: false };
        }
        const plan = planMonthlyPartitions(existing, now(), target.retentionMonths, aheadMonths);
        const catchAll = existing.find((p) => p.upperBound === null);

        if (plan.add.length > 0) {
          const months = plan.add.map(
            (p) => sql`partition ${sql.id(p.name)} values less than (${sql.lit(p.upperBound)})`,
          );
          if (catchAll !== undefined) {
            await sql`alter table ${sql.table(table)} reorganize partition ${sql.id(catchAll.name)} into (
              ${sql.join(months)},
              partition ${sql.id(catchAll.name)} values less than maxvalue
            )`.execute(conn);
          } else {
            await sql`alter table ${sql.table(table)} add partition (${sql.join(months)})`.execute(
              conn,
            );
          }
        }
        if (plan.drop.length > 0) {
          await sql`alter table ${sql.table(table)} drop partition ${sql.join(
            plan.drop.map((name) => sql.id(name)),
          )}`.execute(conn);
        }

        const added = plan.add.map((p) => p.name);
        if (added.length > 0 || plan.drop.length > 0) {
          logger.info(
            { table, added, dropped: plan.drop, retentionMonths: target.retentionMonths },
            `partitions: ${table}: ${String(added.length)} added, ${String(plan.drop.length)} past retention dropped`,
          );
        }
        return { table, added, dropped: plan.drop, skipped: false };
      } finally {
        await sql`select release_lock(${lock})`.execute(conn);
      }
    });
  }

  async function pass(): Promise<PartitionResult[]> {
    const results: PartitionResult[] = [];
    for (const target of targets) results.push(await maintain(target));
    last = results;
    return results;
  }

  /** One pass over every target. Concurrent calls in this process share one pass. */
  function runOnce(): Promise<PartitionResult[]> {
    running ??= pass().finally(() => {
      running = undefined;
    });
    return running;
  }

  function runLogged(): void {
    runOnce().catch((error: unknown) => {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'partitions: pass failed; will retry on the next one',
      );
    });
  }

  return {
    runOnce,

    /** What the last completed pass did, or `undefined` before the first. */
    lastResult(): readonly PartitionResult[] | undefined {
      return last;
    },

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

export type PartitionJob = ReturnType<typeof createPartitionJob>;
