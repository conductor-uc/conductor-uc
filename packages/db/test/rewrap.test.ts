import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import { databaseOrSkipReason, silentLogger } from '@cuc/testing';

import { createRewrapJob, type CiphertextRewrapper } from '../src/rewrap.js';
import { captureLogger } from './helpers.js';
import { openTestDatabase, type TestDatabase } from './test-database.js';

const skipReason = await databaseOrSkipReason();

interface ProbeDb {
  rewrap_probe: { id: string; secret: string | null };
}

const migrations: Record<string, Migration> = {
  '001_rewrap_probe': {
    async up(db: Kysely<unknown>) {
      await db.schema
        .createTable('rewrap_probe')
        .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
        .addColumn('secret', 'text')
        .execute();
    },
  },
};

const TARGETS = [{ table: 'rewrap_probe', idColumn: 'id', column: 'secret' }];

/**
 * A stand-in for `@cuc/crypto`'s rewrapper (this package does not depend on
 * it): `enc1.<version>.<payload>`, current version `Mg` (base64url of "2"),
 * and version `gone` cannot be unwrapped any more.
 */
function fakeRewrapper(onRewrap?: (value: string) => Promise<void>): CiphertextRewrapper {
  return {
    formatPrefix: 'enc1.',
    currentPrefix: () => 'enc1.Mg.',
    async rewrap(value) {
      await onRewrap?.(value);
      const [, version, payload] = value.split('.');
      if (version === 'gone') throw new Error('unknown key version');
      return `enc1.Mg.${payload!}`;
    },
  };
}

describe.skipIf(skipReason !== undefined)('createRewrapJob', () => {
  let database: TestDatabase<ProbeDb>;

  beforeAll(async () => {
    database = await openTestDatabase<ProbeDb>(migrations);
  });

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(async () => {
    await database.db.kysely.deleteFrom('rewrap_probe').execute();
  });

  async function seed(rows: Record<string, string | null>): Promise<void> {
    await database.db.kysely
      .insertInto('rewrap_probe')
      .values(Object.entries(rows).map(([id, secret]) => ({ id, secret })))
      .execute();
  }

  async function values(): Promise<Record<string, string | null>> {
    const rows = await database.db.kysely.selectFrom('rewrap_probe').selectAll().execute();
    return Object.fromEntries(rows.map((row) => [row.id, row.secret]));
  }

  it('rewraps every value under an older version, across several batches', async () => {
    const old: Record<string, string> = {};
    for (let i = 0; i < 10; i += 1) old[`row-${String(i).padStart(2, '0')}`] = `enc1.MQ.p${i}`;
    await seed({ ...old, current: 'enc1.Mg.keep', empty: null, plain: 'not-encrypted' });

    const job = createRewrapJob({
      db: database.db.kysely,
      targets: TARGETS,
      rewrapper: fakeRewrapper(),
      logger: silentLogger(),
      batchSize: 3,
    });
    const result = await job.runOnce();

    expect(result).toEqual({ rewrapped: 10, skipped: 0, failed: 0, remaining: 0 });
    const after = await values();
    for (let i = 0; i < 10; i += 1) {
      expect(after[`row-${String(i).padStart(2, '0')}`]).toBe(`enc1.Mg.p${i}`);
    }
    expect(after['current']).toBe('enc1.Mg.keep');
    expect(after['empty']).toBeNull();
    expect(after['plain']).toBe('not-encrypted');
  });

  it('is idempotent: a second pass finds nothing to do', async () => {
    await seed({ a: 'enc1.MQ.a', b: 'enc1.MQ.b' });
    const job = createRewrapJob({
      db: database.db.kysely,
      targets: TARGETS,
      rewrapper: fakeRewrapper(),
      logger: silentLogger(),
    });

    await job.runOnce();
    const second = await job.runOnce();

    expect(second).toEqual({ rewrapped: 0, skipped: 0, failed: 0, remaining: 0 });
  });

  it('compares the version as bytes, not under a case-insensitive collation', async () => {
    // `mg` is a different version from `Mg`; a _ci collation would call them equal.
    await seed({ a: 'enc1.mg.a' });
    const job = createRewrapJob({
      db: database.db.kysely,
      targets: TARGETS,
      rewrapper: fakeRewrapper(),
      logger: silentLogger(),
    });

    expect((await job.runOnce()).rewrapped).toBe(1);
    expect((await values())['a']).toBe('enc1.Mg.a');
  });

  it('counts a value it cannot rewrap as remaining, logs it without the value, and moves on', async () => {
    await seed({ a: 'enc1.gone.secret-a', b: 'enc1.MQ.b' });
    const { lines, logger } = captureLogger();
    const job = createRewrapJob({
      db: database.db.kysely,
      targets: TARGETS,
      rewrapper: fakeRewrapper(),
      logger,
      batchSize: 1,
    });

    expect(await job.readinessCheck()).toEqual({ status: 'pass', detail: 'not checked yet' });
    const result = await job.runOnce();

    expect(result).toEqual({ rewrapped: 1, skipped: 0, failed: 1, remaining: 1 });
    expect(job.remaining()).toBe(1);
    expect(await job.readinessCheck()).toEqual({
      status: 'pass',
      detail: '1 values under older key versions',
    });
    expect(JSON.stringify(lines)).not.toContain('secret-a');
    expect(
      lines.some((line) => line['msg'] === 'kek re-wrap: 1 values under older key versions'),
    ).toBe(true);
  });

  it('logs once when the count reaches zero', async () => {
    await seed({ a: 'enc1.MQ.a' });
    const { lines, logger } = captureLogger();
    const job = createRewrapJob({
      db: database.db.kysely,
      targets: TARGETS,
      rewrapper: fakeRewrapper(),
      logger,
    });

    await job.runOnce();
    await job.runOnce();

    const done = lines.filter((line) => String(line['msg']).includes('every value is under'));
    expect(done).toHaveLength(1);
  });

  it('never overwrites a value another writer changed after it was read', async () => {
    await seed({ a: 'enc1.MQ.a' });
    const job = createRewrapJob({
      db: database.db.kysely,
      targets: TARGETS,
      // Between the read and the update, the application stores a new value.
      rewrapper: fakeRewrapper(async () => {
        await database.db.kysely
          .updateTable('rewrap_probe')
          .set({ secret: 'enc1.Mg.new-pin' })
          .where('id', '=', 'a')
          .execute();
      }),
      logger: silentLogger(),
    });

    const result = await job.runOnce();

    expect(result).toMatchObject({ rewrapped: 0, skipped: 1, remaining: 0 });
    expect((await values())['a']).toBe('enc1.Mg.new-pin');
  });

  it('two copies running at once rewrap each value once and agree on the result', async () => {
    const rows: Record<string, string> = {};
    for (let i = 0; i < 25; i += 1) rows[`r${String(i).padStart(2, '0')}`] = `enc1.MQ.v${i}`;
    await seed(rows);

    const copy = () =>
      createRewrapJob({
        db: database.db.kysely,
        targets: TARGETS,
        rewrapper: fakeRewrapper(),
        logger: silentLogger(),
        batchSize: 4,
      });
    const [first, second] = await Promise.all([copy().runOnce(), copy().runOnce()]);

    expect(first.rewrapped + second.rewrapped).toBe(25);
    expect(first.remaining).toBe(0);
    expect(second.remaining).toBe(0);
    const after = await values();
    for (let i = 0; i < 25; i += 1) {
      expect(after[`r${String(i).padStart(2, '0')}`]).toBe(`enc1.Mg.v${i}`);
    }
  });

  it('shares one pass between overlapping calls in the same process', async () => {
    await seed({ a: 'enc1.MQ.a' });
    const job = createRewrapJob({
      db: database.db.kysely,
      targets: TARGETS,
      rewrapper: fakeRewrapper(),
      logger: silentLogger(),
    });

    const [one, two] = await Promise.all([job.runOnce(), job.runOnce()]);

    expect(one).toBe(two);
  });

  it('start() runs a pass straight away, and stop() waits for it', async () => {
    await seed({ a: 'enc1.MQ.a' });
    const job = createRewrapJob({
      db: database.db.kysely,
      targets: TARGETS,
      rewrapper: fakeRewrapper(),
      logger: silentLogger(),
    });

    job.start(60_000);
    await job.stop();

    expect(job.remaining()).toBe(0);
    expect((await values())['a']).toBe('enc1.Mg.a');
  });
});
