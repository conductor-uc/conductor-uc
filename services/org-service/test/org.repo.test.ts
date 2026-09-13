import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { databaseOrSkipReason, silentLogger, startTestDatabase } from '@cuc/testing';

import {
  createOrgRepo,
  MasterAlreadyExistsError,
  ParentNotFoundError,
  SlugTakenError,
  type OrgRepo,
} from '../src/repo/org.repo.js';
import { migrations } from '../migrations/index.js';
import type { OrgServiceDb } from '../src/schema.js';

const skipReason = await databaseOrSkipReason();

/**
 * The acceptance criterion for S1-01: invariant tests reject a tenant under
 * master, a reseller under reseller, and a second master. Run against real
 * MariaDB so the CHECK constraints and the partial-unique index — not just the
 * application-level checks — are actually exercised.
 */
describe.skipIf(skipReason !== undefined)('org repo — hierarchy invariants', () => {
  let db: Database<OrgServiceDb>;
  let repo: OrgRepo;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const logger = silentLogger();
    const handle = await startTestDatabase();
    db = createDatabase<OrgServiceDb>({
      host: handle.host,
      port: handle.port,
      user: handle.user,
      password: handle.password,
      database: handle.database,
      logger,
    });
    await migrateToLatest({ db: db.kysely, migrations, logger });
    repo = createOrgRepo(db);
    stop = async () => {
      await db.destroy();
      await handle.stop();
    };
  });

  afterAll(async () => {
    await stop?.();
  });

  beforeEach(async () => {
    // orgs.parent_id is self-referencing, so a child must go before its
    // parent — deepest type first, since a tenant's parent is always a
    // reseller and a reseller's parent is always the master.
    await db.kysely.deleteFrom('orgs').where('type', '=', 'tenant').execute();
    await db.kysely.deleteFrom('orgs').where('type', '=', 'reseller').execute();
    await db.kysely.deleteFrom('orgs').where('type', '=', 'master').execute();
    await db.kysely.deleteFrom('outbox').execute();
  });

  it('creates the master org', async () => {
    const master = await repo.createMaster({ slug: 'master', name: 'Master' });

    expect(master).toMatchObject({ type: 'master', parentId: null, resellerId: null });
    expect(await repo.findById(master.id)).toEqual(master);
  });

  it('rejects a second master', async () => {
    await repo.createMaster({ slug: 'master', name: 'Master' });

    await expect(repo.createMaster({ slug: 'master-2', name: 'Master 2' })).rejects.toThrow(
      MasterAlreadyExistsError,
    );
  });

  it('creates a reseller under the master', async () => {
    const master = await repo.createMaster({ slug: 'master', name: 'Master' });

    const reseller = await repo.create({}, 'reseller', {
      parentId: master.id,
      slug: 'acme',
      name: 'Acme Resale',
    });

    expect(reseller).toMatchObject({
      type: 'reseller',
      parentId: master.id,
      resellerId: null,
    });
  });

  it('creates a tenant under a reseller, denormalizing reseller_id', async () => {
    const master = await repo.createMaster({ slug: 'master', name: 'Master' });
    const reseller = await repo.create({}, 'reseller', {
      parentId: master.id,
      slug: 'acme',
      name: 'Acme Resale',
    });

    const tenant = await repo.create({}, 'tenant', {
      parentId: reseller.id,
      slug: 'widgets-inc',
      name: 'Widgets Inc',
    });

    expect(tenant).toMatchObject({
      type: 'tenant',
      parentId: reseller.id,
      resellerId: reseller.id,
    });
  });

  it('rejects a reseller under a reseller', async () => {
    const master = await repo.createMaster({ slug: 'master', name: 'Master' });
    const reseller = await repo.create({}, 'reseller', {
      parentId: master.id,
      slug: 'acme',
      name: 'Acme Resale',
    });

    await expect(
      repo.create({}, 'reseller', { parentId: reseller.id, slug: 'sub-reseller', name: 'Sub' }),
    ).rejects.toThrow(/must be 'master'/);
  });

  it('rejects a tenant directly under the master — no tenant hangs under master (02 §1)', async () => {
    const master = await repo.createMaster({ slug: 'master', name: 'Master' });

    await expect(
      repo.create({}, 'tenant', { parentId: master.id, slug: 'direct-tenant', name: 'Direct' }),
    ).rejects.toThrow(/must be 'reseller'/);
  });

  it('rejects a tenant under a tenant', async () => {
    const master = await repo.createMaster({ slug: 'master', name: 'Master' });
    const reseller = await repo.create({}, 'reseller', {
      parentId: master.id,
      slug: 'acme',
      name: 'Acme Resale',
    });
    const tenant = await repo.create({}, 'tenant', {
      parentId: reseller.id,
      slug: 'widgets-inc',
      name: 'Widgets Inc',
    });

    await expect(
      repo.create({}, 'tenant', { parentId: tenant.id, slug: 'sub-tenant', name: 'Sub' }),
    ).rejects.toThrow(/must be 'reseller'/);
  });

  it('rejects creating under a parent that does not exist', async () => {
    await expect(
      repo.create({}, 'reseller', { parentId: 'no-such-org', slug: 'acme', name: 'Acme' }),
    ).rejects.toThrow(ParentNotFoundError);
  });

  it('rejects a duplicate slug across the whole hierarchy — slugs are globally unique (02 §3)', async () => {
    const master = await repo.createMaster({ slug: 'master', name: 'Master' });
    await repo.create({}, 'reseller', { parentId: master.id, slug: 'acme', name: 'Acme' });

    await expect(
      repo.create({}, 'reseller', { parentId: master.id, slug: 'acme', name: 'Acme Again' }),
    ).rejects.toThrow(SlugTakenError);
  });

  it('rolls back the parent-type check and the insert together', async () => {
    const master = await repo.createMaster({ slug: 'master', name: 'Master' });
    const reseller = await repo.create({}, 'reseller', {
      parentId: master.id,
      slug: 'acme',
      name: 'Acme',
    });
    const outboxBefore = await db.kysely.selectFrom('outbox').selectAll().execute();

    await expect(
      repo.create({}, 'reseller', { parentId: reseller.id, slug: 'never-inserted', name: 'X' }),
    ).rejects.toThrow();

    expect(await repo.findById('never-inserted')).toBeUndefined();
    // And no orphaned outbox row for a write that never committed — the count
    // is exactly what the valid reseller above produced, no more.
    expect(await db.kysely.selectFrom('outbox').selectAll().execute()).toEqual(outboxBefore);
  });

  it('writes the org row and its event in the same transaction', async () => {
    const master = await repo.createMaster({ slug: 'master', name: 'Master' });

    await repo.create({}, 'reseller', { parentId: master.id, slug: 'acme', name: 'Acme' });

    const outboxRows = await db.kysely.selectFrom('outbox').selectAll().execute();
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.type).toBe('org.reseller.created');
  });

  it('publishes org.tenant.created for a tenant', async () => {
    const master = await repo.createMaster({ slug: 'master', name: 'Master' });
    const reseller = await repo.create({}, 'reseller', {
      parentId: master.id,
      slug: 'acme',
      name: 'Acme',
    });

    await repo.create({}, 'tenant', {
      parentId: reseller.id,
      slug: 'widgets-inc',
      name: 'Widgets',
    });

    const outboxRows = await db.kysely
      .selectFrom('outbox')
      .selectAll()
      .where('type', '=', 'org.tenant.created')
      .execute();
    expect(outboxRows).toHaveLength(1);
  });

  it('lists immediate children of a reseller', async () => {
    const master = await repo.createMaster({ slug: 'master', name: 'Master' });
    const reseller = await repo.create({}, 'reseller', {
      parentId: master.id,
      slug: 'acme',
      name: 'Acme',
    });
    const tenantA = await repo.create({}, 'tenant', {
      parentId: reseller.id,
      slug: 'tenant-a',
      name: 'Tenant A',
    });
    const tenantB = await repo.create({}, 'tenant', {
      parentId: reseller.id,
      slug: 'tenant-b',
      name: 'Tenant B',
    });

    const children = await repo.listChildren(reseller.id);

    expect(children.map((org) => org.id).sort()).toEqual([tenantA.id, tenantB.id].sort());
  });
});
