import { sql, type Kysely } from 'kysely';

/**
 * `cdrs` (S2-18; 06's cdr-service section). Partitioned by month on
 * `start_at`, the same `RANGE COLUMNS` shape identity-service's own
 * `audit_events` migration (003) already established — copied rather than
 * abstracted into a shared helper, since duplicating ~15 lines across two
 * services is cheaper than a new cross-service dependency for it.
 *
 * The primary key is `(id, start_at)` rather than `id` alone for the same
 * reason `audit_events` needs `(id, at)`: MariaDB requires every unique key
 * on a partitioned table to include the partitioning column. The *real*
 * dedupe key is `(call_uuid, node_id, start_at)` — `call_uuid` is a FS
 * channel UUID (globally unique on its own), `node_id` rides along only
 * because `mod_json_cdr`'s own documented retry behavior (07 §1: "FS
 * retries") can legitimately re-POST the same call after a timeout, and a
 * dedupe key needs to tolerate that without erroring on the *second*,
 * identical attempt (`repo/cdr.repo.ts`'s `isDuplicateKeyError` catch turns
 * a hit here into "already ingested," not a failure).
 *
 * No `cdr_extensions` join table and no filled `extension_ids` yet — see
 * this migration's own G-number in docs/decisions.md (G-51) for why
 * `queue_id`, `flow_id`, and `extension_ids` are columns with no extraction
 * logic behind them in this task, the same "schema for a field a later task
 * fills in" precedent `pbx-config-service/src/schema.ts`'s own doc comment
 * sets for `extensions.forwarding`/`dnd`/`max_concurrent`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('cdrs')
    .addColumn('id', 'varchar(36)', (col) => col.notNull())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    /** Denormalized at ingest time (C-1/D-013) — null if the org-service reseller lookup failed or the tenant has none. */
    .addColumn('reseller_id', 'varchar(36)')
    .addColumn('call_uuid', 'varchar(36)', (col) => col.notNull())
    .addColumn('node_id', 'varchar(64)', (col) => col.notNull())
    .addColumn('direction', 'varchar(16)', (col) => col.notNull())
    .addColumn('start_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('answer_at', 'datetime(3)')
    .addColumn('end_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('duration_sec', 'integer', (col) => col.notNull())
    .addColumn('billable_sec', 'integer', (col) => col.notNull())
    .addColumn('from_number', 'varchar(64)', (col) => col.notNull())
    .addColumn('from_name', 'varchar(255)')
    .addColumn('to_number', 'varchar(64)', (col) => col.notNull())
    .addColumn('dialed_number', 'varchar(64)', (col) => col.notNull())
    /** Set for an inbound call only — the DID that was dialed. */
    .addColumn('did', 'varchar(32)')
    .addColumn('trunk_id', 'varchar(36)')
    /** JSON array of extension ids — always `'[]'` today (G-51). */
    .addColumn('extension_ids', 'text', (col) => col.notNull().defaultTo('[]'))
    .addColumn('disposition', 'varchar(16)', (col) => col.notNull())
    .addColumn('hangup_cause', 'varchar(64)', (col) => col.notNull())
    .addColumn('hangup_by', 'varchar(16)', (col) => col.notNull())
    .addColumn('queue_id', 'varchar(36)')
    .addColumn('flow_id', 'varchar(36)')
    /** JSON array of recording ids — always `'[]'` until recording-service exists (S5). Tenant-private (private dataClass). */
    .addColumn('recording_ids', 'text', (col) => col.notNull().defaultTo('[]'))
    /** JSON, best-effort — `mod_json_cdr`'s own `callflow` array, unparsed. Tenant-private. */
    .addColumn('legs', 'text')
    /** JSON, best-effort — codec/MOS/user-agent. Tenant-private. */
    .addColumn('sip', 'text')
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addPrimaryKeyConstraint('cdrs_pk', ['id', 'start_at'])
    .execute();

  await db.schema
    .createIndex('cdrs_dedupe_idx')
    .on('cdrs')
    .columns(['call_uuid', 'node_id', 'start_at'])
    .unique()
    .execute();
  // Leads with tenant_id (05 §2.1), carries start_at for the descending-
  // time-order every list/export query wants (06's own `?from&to&cursor`).
  await db.schema
    .createIndex('cdrs_tenant_start_idx')
    .on('cdrs')
    .columns(['tenant_id', 'start_at'])
    .execute();

  // Monthly RANGE COLUMNS partitions on `start_at`, generated at migration-
  // write time for a multi-year window plus a MAXVALUE catch-all so an
  // insert never fails even past the generated range — identical shape to
  // `audit_events`. Rolling the window forward and dropping/archiving
  // partitions past retention is operational tooling this task does not
  // build, flagged as G-52 (the same gap G-12 already documents for
  // `audit_events`, now also true here).
  await sql`
    alter table cdrs
      partition by range columns (start_at) (
        ${sql.raw(monthlyPartitionClauses(2026, 1, 36))}
      )
  `.execute(db);

  await db.schema
    .createTable('cdr_exports')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('tenant_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('status', 'varchar(16)', (col) => col.notNull())
    .addColumn('from_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('to_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('object_key', 'varchar(255)')
    .addColumn('error_message', 'text')
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .addColumn('updated_at', 'datetime(3)', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('cdr_exports_tenant_idx')
    .on('cdr_exports')
    .column('tenant_id')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('cdr_exports').execute();
  await db.schema.dropTable('cdrs').execute();
}

/**
 * `PARTITION p_before VALUES LESS THAN (...), PARTITION p_2026_01 VALUES LESS
 * THAN (...), …, PARTITION p_max VALUES LESS THAN MAXVALUE` — one partition
 * per month from `fromYear`-`fromMonth`, for `count` months. Copied from
 * identity-service's `003_audit_events.ts` (same shape, same reasoning).
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
