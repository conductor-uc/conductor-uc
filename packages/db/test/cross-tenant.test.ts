import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertTenantIsolation, databaseOrSkipReason, TenantIsolationError } from '@cuc/testing';

import {
  brokenWidgetsRepo,
  correctWidgetsRepo,
  emptyWidgetsRepo,
} from './fixtures/repositories.js';
import { testMigrations, type TestDb } from './fixtures/schema.js';
import { openTestDatabase, type TestDatabase } from './test-database.js';

const skipReason = await databaseOrSkipReason();

describe.skipIf(skipReason !== undefined)('cross-tenant probe', () => {
  let database: TestDatabase<TestDb>;

  beforeAll(async () => {
    database = await openTestDatabase<TestDb>(testMigrations);
  });

  afterAll(async () => {
    await database?.close();
  });

  it('passes for a repository that scopes every query', async () => {
    await expect(assertTenantIsolation(correctWidgetsRepo(database.db))).resolves.toBeUndefined();
  });

  it('fails for a repository that omits scoping', async () => {
    await expect(assertTenantIsolation(brokenWidgetsRepo(database.db))).rejects.toThrow(
      TenantIsolationError,
    );
  });

  it('names the missing predicate so the failure says what to fix', async () => {
    await expect(assertTenantIsolation(brokenWidgetsRepo(database.db))).rejects.toThrow(
      /missing its tenant_id predicate — use scoped\(ctx\)/,
    );
  });

  it('fails for a repository that reads nothing, rather than passing vacuously', async () => {
    await expect(assertTenantIsolation(emptyWidgetsRepo(database.db))).rejects.toThrow(
      /cannot see its own row/,
    );
  });

  it('catches a cross-tenant read by primary key', async () => {
    const broken = brokenWidgetsRepo(database.db);
    const correct = correctWidgetsRepo(database.db);

    // Scoped list, unscoped lookup by id — the shape where a primary-key read
    // quietly skips the tenant predicate.
    await expect(
      assertTenantIsolation({
        name: 'widgets (findById unscoped)',
        seed: correct.seed,
        list: correct.list,
        findById: broken.findById!,
      }),
    ).rejects.toThrow(/findById\(tenantA, .*\) returned tenant B's row/);
  });

  it('catches a cross-tenant update', async () => {
    const broken = brokenWidgetsRepo(database.db);
    const correct = correctWidgetsRepo(database.db);

    await expect(
      assertTenantIsolation({
        name: 'widgets (update unscoped)',
        seed: correct.seed,
        list: correct.list,
        update: broken.update!,
      }),
    ).rejects.toThrow(/of tenant B's rows/);
  });

  it('catches a cross-tenant delete', async () => {
    const broken = brokenWidgetsRepo(database.db);
    const correct = correctWidgetsRepo(database.db);

    await expect(
      assertTenantIsolation({
        name: 'widgets (delete unscoped)',
        seed: correct.seed,
        list: correct.list,
        remove: broken.remove!,
      }),
    ).rejects.toThrow(/of tenant B's rows/);
  });

  it('probes only the capabilities a repository declares', async () => {
    const correct = correctWidgetsRepo(database.db);

    await expect(
      assertTenantIsolation({
        name: correct.name,
        seed: correct.seed,
        list: correct.list,
      }),
    ).resolves.toBeUndefined();
  });
});
