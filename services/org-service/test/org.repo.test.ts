import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { databaseOrSkipReason, silentLogger, startTestDatabase } from '@cuc/testing';

import {
  createOrgRepo,
  MasterAlreadyExistsError,
  OrgNotFoundError,
  ParentNotFoundError,
  SlugTakenError,
  type OrgRepo,
} from '../src/repo/org.repo.js';
import { InvalidOrgStatusTransitionError } from '../src/domain/org.js';
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

  it("cross-reseller probe: listing one reseller's tenants never returns another reseller's (05 §2.4)", async () => {
    const master = await repo.createMaster({ slug: 'master', name: 'Master' });
    const resellerA = await repo.create({}, 'reseller', {
      parentId: master.id,
      slug: 'reseller-a',
      name: 'A',
    });
    const resellerB = await repo.create({}, 'reseller', {
      parentId: master.id,
      slug: 'reseller-b',
      name: 'B',
    });
    const tenantA = await repo.create({}, 'tenant', {
      parentId: resellerA.id,
      slug: 'tenant-a',
      name: 'Tenant A',
    });
    await repo.create({}, 'tenant', { parentId: resellerB.id, slug: 'tenant-b', name: 'Tenant B' });

    const tenantsForA = await repo.listChildren(resellerA.id);

    expect(tenantsForA.map((org) => org.id)).toEqual([tenantA.id]);
  });

  describe('findMaster', () => {
    it('is undefined before bootstrap', async () => {
      expect(await repo.findMaster()).toBeUndefined();
    });

    it('finds the master once created', async () => {
      const master = await repo.createMaster({ slug: 'master', name: 'Master' });

      expect((await repo.findMaster())?.id).toBe(master.id);
    });
  });

  describe('update', () => {
    it('updates name, timezone, country, and limits, bumping the version', async () => {
      const master = await repo.createMaster({ slug: 'master', name: 'Master' });
      const reseller = await repo.create({}, 'reseller', {
        parentId: master.id,
        slug: 'acme',
        name: 'Acme',
      });

      const updated = await repo.update({}, reseller.id, {
        name: 'Acme Resale',
        timezone: 'America/New_York',
        country: 'CA',
        limits: { maxExtensions: 50 },
      });

      expect(updated).toMatchObject({
        name: 'Acme Resale',
        timezone: 'America/New_York',
        country: 'CA',
        limits: { maxExtensions: 50 },
      });
      expect(await repo.findById(reseller.id)).toEqual(updated);
    });

    it('leaves unspecified fields alone', async () => {
      const master = await repo.createMaster({ slug: 'master', name: 'Master' });
      const reseller = await repo.create({}, 'reseller', {
        parentId: master.id,
        slug: 'acme',
        name: 'Acme',
      });

      const updated = await repo.update({}, reseller.id, { name: 'Renamed' });

      expect(updated).toMatchObject({ name: 'Renamed', timezone: 'UTC', country: 'US' });
    });

    it('rejects updating a nonexistent org', async () => {
      await expect(repo.update({}, 'no-such-org', { name: 'X' })).rejects.toThrow(OrgNotFoundError);
    });

    it('publishes org.reseller.updated / org.tenant.updated', async () => {
      const master = await repo.createMaster({ slug: 'master', name: 'Master' });
      const reseller = await repo.create({}, 'reseller', {
        parentId: master.id,
        slug: 'acme',
        name: 'Acme',
      });

      await repo.update({}, reseller.id, { name: 'Renamed' });

      const rows = await db.kysely
        .selectFrom('outbox')
        .selectAll()
        .where('type', '=', 'org.reseller.updated')
        .execute();
      expect(rows).toHaveLength(1);
    });
  });

  describe('suspend / resume', () => {
    it('suspends an active org and resumes it', async () => {
      const master = await repo.createMaster({ slug: 'master', name: 'Master' });
      const reseller = await repo.create({}, 'reseller', {
        parentId: master.id,
        slug: 'acme',
        name: 'Acme',
      });

      const suspended = await repo.suspend({}, reseller.id);
      expect(suspended.status).toBe('suspended');

      const resumed = await repo.resume({}, reseller.id);
      expect(resumed.status).toBe('active');
    });

    it('rejects suspending an org that is already suspended', async () => {
      const master = await repo.createMaster({ slug: 'master', name: 'Master' });
      const reseller = await repo.create({}, 'reseller', {
        parentId: master.id,
        slug: 'acme',
        name: 'Acme',
      });
      await repo.suspend({}, reseller.id);

      await expect(repo.suspend({}, reseller.id)).rejects.toThrow(InvalidOrgStatusTransitionError);
    });

    it('rejects resuming an org that is not suspended', async () => {
      const master = await repo.createMaster({ slug: 'master', name: 'Master' });
      const reseller = await repo.create({}, 'reseller', {
        parentId: master.id,
        slug: 'acme',
        name: 'Acme',
      });

      await expect(repo.resume({}, reseller.id)).rejects.toThrow(InvalidOrgStatusTransitionError);
    });

    it('rejects suspending a nonexistent org', async () => {
      await expect(repo.suspend({}, 'no-such-org')).rejects.toThrow(OrgNotFoundError);
    });

    it('publishes org.tenant.suspended and org.tenant.resumed', async () => {
      const master = await repo.createMaster({ slug: 'master', name: 'Master' });
      const reseller = await repo.create({}, 'reseller', {
        parentId: master.id,
        slug: 'acme',
        name: 'Acme',
      });
      const tenant = await repo.create({}, 'tenant', {
        parentId: reseller.id,
        slug: 'widgets',
        name: 'Widgets',
      });

      await repo.suspend({}, tenant.id);
      await repo.resume({}, tenant.id);

      const types = (await db.kysely.selectFrom('outbox').select('type').execute()).map(
        (row) => row.type,
      );
      expect(types).toEqual(expect.arrayContaining(['org.tenant.suspended', 'org.tenant.resumed']));
    });
  });
});
