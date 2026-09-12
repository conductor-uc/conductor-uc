import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseOrSkipReason } from '@cuc/testing';

import { MissingTenantContextError } from '../src/context.js';
import { scopedFor } from '../src/scoped.js';
import { testMigrations, type TestDb } from './fixtures/schema.js';
import { openTestDatabase, type TestDatabase } from './test-database.js';

const skipReason = await databaseOrSkipReason();

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const ctxA = { tenantId: TENANT_A, orgType: 'tenant' as const };
const ctxB = { tenantId: TENANT_B, orgType: 'tenant' as const };

describe.skipIf(skipReason !== undefined)('scoped', () => {
  let database: TestDatabase<TestDb>;

  beforeAll(async () => {
    database = await openTestDatabase<TestDb>(testMigrations);
  });

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(async () => {
    await database.db.kysely.deleteFrom('widgets').execute();
  });

  async function seed(tenantId: string, label: string): Promise<string> {
    const id = randomUUID();
    await database.db
      .scoped({ tenantId })
      .insertInto('widgets')
      .values({ id, label, version: 1 })
      .execute();
    return id;
  }

  describe('insert', () => {
    it('sets tenant_id without the caller passing it', async () => {
      const id = await seed(TENANT_A, 'one');

      const row = await database.db.kysely
        .selectFrom('widgets')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

      expect(row.tenant_id).toBe(TENANT_A);
    });

    it('sets tenant_id on every row of a bulk insert', async () => {
      await database.db
        .scoped(ctxA)
        .insertInto('widgets')
        .values([
          { id: randomUUID(), label: 'a', version: 1 },
          { id: randomUUID(), label: 'b', version: 1 },
        ])
        .execute();

      const rows = await database.db.kysely.selectFrom('widgets').selectAll().execute();
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.tenant_id === TENANT_A)).toBe(true);
    });

    it('still exposes the rest of the Kysely builder after values()', async () => {
      const id = randomUUID();
      await database.db
        .scoped(ctxA)
        .insertInto('widgets')
        .values({ id, label: 'first', version: 1 })
        .execute();

      await database.db
        .scoped(ctxA)
        .insertInto('widgets')
        .values({ id, label: 'second', version: 2 })
        .onDuplicateKeyUpdate({ label: 'updated' })
        .execute();

      const rows = await database.db.kysely.selectFrom('widgets').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.label).toBe('updated');
    });
  });

  describe('select', () => {
    it('returns only the scoped tenant’s rows', async () => {
      await seed(TENANT_A, 'a-one');
      await seed(TENANT_B, 'b-one');

      const rows = await database.db.scoped(ctxA).selectFrom('widgets').selectAll().execute();

      expect(rows).toHaveLength(1);
      expect(rows[0]!.label).toBe('a-one');
    });

    it('finds nothing for a tenant with no rows', async () => {
      await seed(TENANT_A, 'a-one');

      expect(await database.db.scoped(ctxB).selectFrom('widgets').selectAll().execute()).toEqual(
        [],
      );
    });

    it('keeps the predicate when the caller adds their own where', async () => {
      const idA = await seed(TENANT_A, 'shared-label');
      await seed(TENANT_B, 'shared-label');

      const rows = await database.db
        .scoped(ctxA)
        .selectFrom('widgets')
        .selectAll()
        .where('label', '=', 'shared-label')
        .execute();

      expect(rows.map((row) => row.id)).toEqual([idA]);
    });

    it('qualifies the column so a join stays unambiguous', async () => {
      await seed(TENANT_A, 'joined');

      const rows = await database.db
        .scoped(ctxA)
        .selectFrom('widgets')
        .innerJoin('platform_settings', (join) => join.onTrue())
        .select(['widgets.id'])
        .execute();

      expect(rows).toEqual([]);
    });
  });

  describe('update', () => {
    it('updates the scoped tenant’s row', async () => {
      const id = await seed(TENANT_A, 'before');

      const result = await database.db
        .scoped(ctxA)
        .updateTable('widgets')
        .set({ label: 'after' })
        .where('id', '=', id)
        .executeTakeFirst();

      expect(Number(result.numUpdatedRows)).toBe(1);
    });

    it('cannot touch another tenant’s row even by primary key', async () => {
      const idB = await seed(TENANT_B, 'b-one');

      const result = await database.db
        .scoped(ctxA)
        .updateTable('widgets')
        .set({ label: 'hijacked' })
        .where('id', '=', idB)
        .executeTakeFirst();

      expect(Number(result.numUpdatedRows)).toBe(0);

      const row = await database.db.kysely
        .selectFrom('widgets')
        .selectAll()
        .where('id', '=', idB)
        .executeTakeFirstOrThrow();
      expect(row.label).toBe('b-one');
    });
  });

  describe('delete', () => {
    it('deletes the scoped tenant’s row', async () => {
      const id = await seed(TENANT_A, 'doomed');

      const result = await database.db
        .scoped(ctxA)
        .deleteFrom('widgets')
        .where('id', '=', id)
        .executeTakeFirst();

      expect(Number(result.numDeletedRows)).toBe(1);
    });

    it('cannot delete another tenant’s row', async () => {
      const idB = await seed(TENANT_B, 'b-one');

      const result = await database.db
        .scoped(ctxA)
        .deleteFrom('widgets')
        .where('id', '=', idB)
        .executeTakeFirst();

      expect(Number(result.numDeletedRows)).toBe(0);
      expect(await database.db.kysely.selectFrom('widgets').selectAll().execute()).toHaveLength(1);
    });

    it('deletes nothing when no predicate is added, beyond its own tenant', async () => {
      await seed(TENANT_A, 'a-one');
      await seed(TENANT_A, 'a-two');
      await seed(TENANT_B, 'b-one');

      const result = await database.db.scoped(ctxA).deleteFrom('widgets').executeTakeFirst();

      expect(Number(result.numDeletedRows)).toBe(2);
      const remaining = await database.db.kysely.selectFrom('widgets').selectAll().execute();
      expect(remaining.map((row) => row.tenant_id)).toEqual([TENANT_B]);
    });
  });

  describe('transaction', () => {
    it('stays scoped inside a transaction', async () => {
      await database.db.scoped(ctxA).transaction(async (trx) => {
        await trx
          .insertInto('widgets')
          .values({ id: randomUUID(), label: 'in-trx', version: 1 })
          .execute();
      });

      const rows = await database.db.kysely.selectFrom('widgets').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tenant_id).toBe(TENANT_A);
    });

    it('rolls back on a thrown error', async () => {
      await expect(
        database.db.scoped(ctxA).transaction(async (trx) => {
          await trx
            .insertInto('widgets')
            .values({ id: randomUUID(), label: 'x', version: 1 })
            .execute();
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');

      expect(await database.db.kysely.selectFrom('widgets').selectAll().execute()).toEqual([]);
    });

    it('joins the open transaction rather than pretending to nest', async () => {
      await database.db.scoped(ctxA).transaction(async (outer) => {
        await outer.transaction(async (inner) => {
          await inner
            .insertInto('widgets')
            .values({ id: randomUUID(), label: 'nested', version: 1 })
            .execute();
        });
      });

      expect(await database.db.kysely.selectFrom('widgets').selectAll().execute()).toHaveLength(1);
    });
  });

  describe('ping', () => {
    it('reports a reachable database, for GET /readyz', async () => {
      expect(await database.db.ping()).toBe(true);
    });
  });
});

describe('scoped without a tenant', () => {
  it('throws rather than silently querying every tenant', () => {
    const executor = {} as Parameters<typeof scopedFor>[0];

    expect(() => scopedFor(executor, { orgType: 'master' })).toThrow(MissingTenantContextError);
    expect(() => scopedFor(executor, { tenantId: '' })).toThrow(MissingTenantContextError);
  });

  it('points the author at unscoped(ctx, reason)', () => {
    const executor = {} as Parameters<typeof scopedFor>[0];

    expect(() => scopedFor(executor, {})).toThrow(/unscoped\(ctx, reason\)/);
  });
});
