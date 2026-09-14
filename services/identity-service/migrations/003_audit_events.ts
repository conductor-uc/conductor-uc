import { sql, type Kysely } from 'kysely';

/**
 * `audit_events` (05 §3.2, 07 §4): append-only, partitioned by month.
 *
 * The primary key is `(id, at)` rather than `id` alone — MariaDB requires
 * every unique key on a partitioned table to include the partitioning
 * column, and `at` is what this table partitions on. `id` (a UUID) still
 * carries the actual uniqueness; `at` just has to ride along.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('audit_events')
    .addColumn('id', 'varchar(36)', (col) => col.notNull())
    .addColumn('at', 'datetime(3)', (col) => col.notNull())
    .addColumn('actor_type', 'varchar(16)', (col) => col.notNull())
    .addColumn('actor_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('actor_org_id', 'varchar(36)', (col) => col.notNull())
    /** Null for an action with no single target, e.g. a cross-tenant dashboard query. */
    .addColumn('target_org_id', 'varchar(36)')
    .addColumn('action', 'varchar(64)', (col) => col.notNull())
    .addColumn('resource', 'varchar(255)', (col) => col.notNull())
    .addColumn('data_class', 'varchar(16)', (col) => col.notNull())
    .addColumn('reason', 'text')
    .addColumn('ip', 'varchar(45)')
    .addColumn('request_id', 'varchar(36)')
    .addPrimaryKeyConstraint('audit_events_pk', ['id', 'at'])
    .execute();

  // Both lead with the org column an audit-trail query filters on, and carry
  // `at` for the descending-time-order every such query also wants.
  await db.schema
    .createIndex('audit_events_actor_org_idx')
    .on('audit_events')
    .columns(['actor_org_id', 'at'])
    .execute();
  await db.schema
    .createIndex('audit_events_target_org_idx')
    .on('audit_events')
    .columns(['target_org_id', 'at'])
    .execute();

  // Monthly RANGE COLUMNS partitions on `at`, generated at migration-write
  // time for a multi-year window plus a MAXVALUE catch-all so an insert
  // never fails even past the generated range. Rolling the window forward
  // (adding future partitions) and dropping partitions past the retention
  // window (07 §4: "configurable, default 1 year") is operational tooling
  // this task does not build — flagged as G-14 in docs/decisions.md.
  await sql`
    alter table audit_events
      partition by range columns (at) (
        ${sql.raw(monthlyPartitionClauses(2026, 1, 36))}
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('audit_events').execute();
}

/**
 * `PARTITION p_before VALUES LESS THAN (...), PARTITION p_2026_01 VALUES LESS
 * THAN (...), …, PARTITION p_max VALUES LESS THAN MAXVALUE` — one partition
 * per month from `fromYear`-`fromMonth`, for `count` months.
 */
function monthlyPartitionClauses(fromYear: number, fromMonth: number, count: number): string {
  const firstBoundary = isoDate(fromYear, fromMonth);
  const clauses = [`partition p_before values less than ('${firstBoundary}')`];

  for (let i = 0; i < count; i++) {
    const partitionDate = new Date(Date.UTC(fromYear, fromMonth - 1 + i, 1));
    const label = `p_${String(partitionDate.getUTCFullYear())}_${String(partitionDate.getUTCMonth() + 1).padStart(2, '0')}`;
    const upperBoundary = new Date(Date.UTC(fromYear, fromMonth - 1 + i + 1, 1));
    clauses.push(
      `partition ${label} values less than ('${upperBoundary.toISOString().slice(0, 10)}')`,
    );
  }

  clauses.push('partition p_max values less than maxvalue');
  return clauses.join(',\n        ');
}

function isoDate(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
}
