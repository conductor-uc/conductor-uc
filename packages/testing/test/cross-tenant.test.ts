import { describe, expect, it } from 'vitest';

import {
  assertTenantIsolation,
  TenantIsolationError,
  type TenantProbeSubject,
} from '../src/cross-tenant.js';

/**
 * The probe's logic, exercised against in-memory subjects.
 *
 * These stand in for the shapes a real repository can be broken in, and run
 * without a database. `@cuc/db` runs the same probe against real MariaDB with a
 * real scoped repository, which is what proves the probe works on actual SQL.
 */
interface Row {
  id: string;
  tenantId: string;
}

function fakeRepo(overrides: Partial<TenantProbeSubject<string>> = {}): TenantProbeSubject<string> {
  const rows: Row[] = [];
  let next = 0;

  const base: TenantProbeSubject<string> = {
    name: 'fake',
    seed: (tenantId) => {
      const id = `row-${String(++next)}`;
      rows.push({ id, tenantId });
      return Promise.resolve(id);
    },
    list: (tenantId) => Promise.resolve(rows.filter((row) => row.tenantId === tenantId)),
    findById: (tenantId, id) =>
      Promise.resolve(rows.find((row) => row.id === id && row.tenantId === tenantId)),
    update: (tenantId, id) =>
      Promise.resolve(rows.filter((row) => row.id === id && row.tenantId === tenantId).length),
    remove: (tenantId, id) => {
      const before = rows.length;
      const kept = rows.filter((row) => !(row.id === id && row.tenantId === tenantId));
      rows.length = 0;
      rows.push(...kept);
      return Promise.resolve(before - rows.length);
    },
  };

  // The overrides need the same `rows` array, so they are applied over the base
  // rather than built independently.
  return { ...base, ...overrides, name: overrides.name ?? base.name };
}

describe('assertTenantIsolation', () => {
  it('passes a correctly scoped repository', async () => {
    await expect(assertTenantIsolation(fakeRepo())).resolves.toBeUndefined();
  });

  it('uses the tenant ids it is given', async () => {
    const seen: string[] = [];
    const repo = fakeRepo();

    await assertTenantIsolation(
      {
        ...repo,
        seed: (tenantId) => {
          seen.push(tenantId);
          return repo.seed(tenantId);
        },
      },
      { tenantA: 'tenant-a', tenantB: 'tenant-b' },
    );

    expect(seen).toEqual(['tenant-a', 'tenant-b']);
  });

  it('names the probe in the failure', async () => {
    await expect(
      assertTenantIsolation(fakeRepo({ name: 'queues', list: () => Promise.resolve([]) })),
    ).rejects.toThrow(/probe "queues" failed/);
  });

  it('requires only seed and list', async () => {
    const repo = fakeRepo();

    await expect(
      assertTenantIsolation({ name: repo.name, seed: repo.seed, list: repo.list }),
    ).resolves.toBeUndefined();
  });
});

describe('what the probe catches', () => {
  it('a list that returns every tenant’s rows', async () => {
    const rows: Row[] = [];
    let next = 0;
    const leaky: TenantProbeSubject<string> = {
      name: 'leaky list',
      seed: (tenantId) => {
        const id = `row-${String(++next)}`;
        rows.push({ id, tenantId });
        return Promise.resolve(id);
      },
      list: () => Promise.resolve(rows),
    };

    await expect(assertTenantIsolation(leaky)).rejects.toThrow(
      /list\(tenantA\) returned tenant B's row/,
    );
  });

  it('a list that returns nothing at all', async () => {
    await expect(
      assertTenantIsolation(fakeRepo({ list: () => Promise.resolve([]) })),
    ).rejects.toThrow(/cannot see its own row/);
  });

  it('a findById that ignores the tenant', async () => {
    const repo = fakeRepo();
    const ids: string[] = [];

    await expect(
      assertTenantIsolation({
        ...repo,
        seed: async (tenantId) => {
          const id = await repo.seed(tenantId);
          ids.push(id);
          return id;
        },
        findById: (_tenantId, id) => Promise.resolve(ids.includes(id) ? { id } : undefined),
      }),
    ).rejects.toThrow(/returned tenant B's row/);
  });

  it('an update that reaches across tenants', async () => {
    await expect(
      assertTenantIsolation(fakeRepo({ update: () => Promise.resolve(1) })),
    ).rejects.toThrow(/of tenant B's rows/);
  });

  it('an update that cannot touch its own row', async () => {
    await expect(
      assertTenantIsolation(fakeRepo({ update: () => Promise.resolve(0) })),
    ).rejects.toThrow(/affected no rows of its own/);
  });

  it('a delete that reports zero rows but deletes anyway', async () => {
    const repo = fakeRepo();
    const deleted = new Set<string>();

    await expect(
      assertTenantIsolation({
        ...repo,
        list: async (tenantId) => (await repo.list(tenantId)).filter((row) => !deleted.has(row.id)),
        remove: (_tenantId, id) => {
          deleted.add(id);
          return Promise.resolve(0);
        },
      }),
    ).rejects.toThrow(/reported 0 rows but tenant B's row is gone/);
  });

  it('throws TenantIsolationError, carrying the probe name', async () => {
    const error = await assertTenantIsolation(
      fakeRepo({ name: 'cdrs', list: () => Promise.resolve([]) }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TenantIsolationError);
    expect((error as TenantIsolationError).probe).toBe('cdrs');
  });
});
