import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import { databaseOrSkipReason, silentLogger } from '@cuc/testing';

import { createPartitionJob, planMonthlyPartitions } from '../src/partitions.js';
import { openTestDatabase, type TestDatabase } from './test-database.js';

const skipReason = await databaseOrSkipReason();

/** `p_before`, then one partition per month from `from` for `count` months, then `p_max`. */
function layout(from: [number, number], count: number) {
  const bound = (i: number) =>
    new Date(Date.UTC(from[0], from[1] - 1 + i, 1)).toISOString().slice(0, 10);
  const parts = [{ name: 'p_before', upperBound: bound(0) }];
  for (let i = 0; i < count; i++) {
    const start = new Date(Date.UTC(from[0], from[1] - 1 + i, 1));
    parts.push({
      name: `p_${String(start.getUTCFullYear())}_${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
      upperBound: bound(i + 1),
    });
  }
  return [...parts, { name: 'p_max', upperBound: null }];
}

describe('planMonthlyPartitions (S2-21)', () => {
  const september = new Date('2026-09-28T12:00:00Z');

  it('keeps 13 whole months: in September 2026 July 2025 goes and August 2025 stays', () => {
    const plan = planMonthlyPartitions(layout([2025, 6], 24), september, 13);
    expect(plan.drop).toEqual(['p_before', 'p_2025_06', 'p_2025_07']);
    expect(plan.drop).not.toContain('p_2025_08');
    expect(plan.drop).not.toContain('p_max');
  });

  it('adds the months up to three ahead that have no partition yet', () => {
    // Partitions end with September 2026.
    const plan = planMonthlyPartitions(layout([2026, 1], 9), september, 12);
    expect(plan.add).toEqual([
      { name: 'p_2026_10', upperBound: '2026-11-01' },
      { name: 'p_2026_11', upperBound: '2026-12-01' },
      { name: 'p_2026_12', upperBound: '2027-01-01' },
    ]);
  });

  it('has nothing to do when the window already reaches far enough and nothing is old', () => {
    const plan = planMonthlyPartitions(layout([2026, 1], 36), september, 12);
    expect(plan).toEqual({ add: [], drop: [] });
  });

  it('crosses a year end', () => {
    const plan = planMonthlyPartitions(
      layout([2026, 1], 12),
      new Date('2026-12-15T00:00:00Z'),
      12,
      2,
    );
    expect(plan.add.map((p) => p.name)).toEqual(['p_2027_01', 'p_2027_02']);
    // December 2025 (in `p_before`) is still within 12 whole months.
    expect(plan.drop).toEqual([]);
  });

  it('refuses a retention that is not a whole number of months', () => {
    expect(() => planMonthlyPartitions([], september, 0)).toThrow(RangeError);
    expect(() => planMonthlyPartitions([], september, 1.5)).toThrow(RangeError);
  });
});

interface ProbeDb {
  partition_probe: { id: string; at: Date };
}

const migrations: Record<string, Migration> = {
  '001_partition_probe': {
    async up(db: Kysely<unknown>) {
      await db.schema
        .createTable('partition_probe')
        .addColumn('id', 'varchar(36)', (col) => col.notNull())
        .addColumn('at', 'datetime(3)', (col) => col.notNull())
        .addPrimaryKeyConstraint('partition_probe_pk', ['id', 'at'])
        .execute();
      await sql`alter table partition_probe partition by range columns (at) (
        partition p_before values less than ('2025-01-01'),
        partition p_2025_01 values less than ('2025-02-01'),
        partition p_2025_02 values less than ('2025-03-01'),
        partition p_max values less than maxvalue
      )`.execute(db);
    },
  },
};

describe.skipIf(skipReason !== undefined)('the partition job, on MariaDB (S2-21)', () => {
  let test: TestDatabase<ProbeDb>;

  beforeAll(async () => {
    test = await openTestDatabase<ProbeDb>(migrations);
    await test.db.kysely
      .insertInto('partition_probe')
      .values([
        { id: 'old', at: new Date('2025-01-15T00:00:00Z') },
        { id: 'kept', at: new Date('2025-02-15T00:00:00Z') },
        { id: 'later', at: new Date('2025-06-15T00:00:00Z') },
      ])
      .execute();
  }, 120_000);

  afterAll(async () => {
    await test?.close();
  });

  async function names(): Promise<string[]> {
    const { rows } = await sql<{ name: string }>`
      select partition_name as name from information_schema.partitions
      where table_schema = database() and table_name = 'partition_probe'
      order by partition_ordinal_position`.execute(test.db.kysely);
    return rows.map((r) => r.name);
  }

  it('drops the months past retention, splits the months ahead out of p_max, and keeps every other row', async () => {
    const job = createPartitionJob({
      db: test.db.kysely,
      targets: [{ table: 'partition_probe', retentionMonths: 1 }],
      logger: silentLogger(),
      // March 2025, one month kept: January goes, February stays.
      now: () => new Date('2025-03-10T00:00:00Z'),
      aheadMonths: 2,
    });
    const [result] = await job.runOnce();
    expect(result).toEqual({
      table: 'partition_probe',
      added: ['p_2025_03', 'p_2025_04', 'p_2025_05'],
      dropped: ['p_before', 'p_2025_01'],
      skipped: false,
    });
    expect(await names()).toEqual(['p_2025_02', 'p_2025_03', 'p_2025_04', 'p_2025_05', 'p_max']);
    const left = await test.db.kysely.selectFrom('partition_probe').select('id').execute();
    expect(left.map((r) => r.id).sort()).toEqual(['kept', 'later']);

    // A second pass has nothing to do.
    const [again] = await job.runOnce();
    expect(again).toMatchObject({ added: [], dropped: [] });
  });

  it('leaves a table another copy is working on', async () => {
    const job = createPartitionJob({
      db: test.db.kysely,
      targets: [{ table: 'partition_probe', retentionMonths: 1 }],
      logger: silentLogger(),
      now: () => new Date('2025-09-10T00:00:00Z'),
    });
    await test.db.kysely.connection().execute(async (conn) => {
      await sql`select get_lock('partitions:partition_probe', 0)`.execute(conn);
      try {
        const [result] = await job.runOnce();
        expect(result).toMatchObject({ skipped: true, added: [], dropped: [] });
      } finally {
        await sql`select release_lock('partitions:partition_probe')`.execute(conn);
      }
    });
  });
});
