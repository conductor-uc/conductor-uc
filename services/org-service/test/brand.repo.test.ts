import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { databaseOrSkipReason, silentLogger, startTestDatabase } from '@cuc/testing';

import { InsufficientContrastError, InvalidColorError } from '../src/domain/color.js';
import { InvalidFqdnError } from '../src/domain/domain.js';
import {
  ConsoleHostnameTakenError,
  createBrandRepo,
  type BrandRepo,
} from '../src/repo/brand.repo.js';
import { createOrgRepo, type OrgRepo } from '../src/repo/org.repo.js';
import { migrations } from '../migrations/index.js';
import type { OrgServiceDb } from '../src/schema.js';

const skipReason = await databaseOrSkipReason();

describe.skipIf(skipReason !== undefined)('brand repo', () => {
  let db: Database<OrgServiceDb>;
  let brands: BrandRepo;
  let orgs: OrgRepo;
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
    brands = createBrandRepo(db);
    orgs = createOrgRepo(db, { platformBaseDomain: 'platform.test' });
    stop = async () => {
      await db.destroy();
      await handle.stop();
    };
  });

  afterAll(async () => {
    await stop?.();
  });

  beforeEach(async () => {
    await db.kysely.deleteFrom('console_hostnames').execute();
    await db.kysely.deleteFrom('brands').execute();
    await db.kysely.deleteFrom('tenant_domains').execute();
    await db.kysely.deleteFrom('reseller_base_domains').execute();
    await db.kysely.deleteFrom('orgs').where('type', '=', 'tenant').execute();
    await db.kysely.deleteFrom('orgs').where('type', '=', 'reseller').execute();
    await db.kysely.deleteFrom('orgs').where('type', '=', 'master').execute();
    await db.kysely.deleteFrom('outbox').execute();
  });

  async function makeReseller() {
    const master = await orgs.createMaster({ slug: 'master', name: 'Master' });
    return orgs.create({}, 'reseller', { parentId: master.id, slug: 'acme', name: 'Acme' });
  }

  describe('upsertBrand', () => {
    it('creates a brand on first call', async () => {
      const reseller = await makeReseller();

      const brand = await brands.upsertBrand({}, reseller.id, {
        displayName: 'Acme Voice',
        primaryColor: '#000000',
        accentColor: '#ffffff',
      });

      expect(brand).toMatchObject({
        resellerId: reseller.id,
        displayName: 'Acme Voice',
        primaryColor: '#000000',
        accentColor: '#ffffff',
      });
      expect(await brands.findBrand(reseller.id)).toEqual(brand);
    });

    it('merges a partial update onto the existing row rather than clearing everything else', async () => {
      const reseller = await makeReseller();
      await brands.upsertBrand({}, reseller.id, {
        displayName: 'Acme Voice',
        primaryColor: '#000000',
        accentColor: '#ffffff',
        supportEmail: 'help@acme.example',
      });

      const updated = await brands.upsertBrand({}, reseller.id, { displayName: 'Acme Voice 2' });

      expect(updated).toMatchObject({
        displayName: 'Acme Voice 2',
        primaryColor: '#000000',
        accentColor: '#ffffff',
        supportEmail: 'help@acme.example',
      });
    });

    it('clears a field when the patch explicitly sets it to null', async () => {
      const reseller = await makeReseller();
      await brands.upsertBrand({}, reseller.id, { supportEmail: 'help@acme.example' });

      const updated = await brands.upsertBrand({}, reseller.id, { supportEmail: null });

      expect(updated.supportEmail).toBeNull();
    });

    it('rejects an invalid hex color', async () => {
      const reseller = await makeReseller();

      await expect(
        brands.upsertBrand({}, reseller.id, { primaryColor: 'not-a-color' }),
      ).rejects.toThrow(InvalidColorError);
    });

    it('rejects a primary/accent pair below WCAG AA, even set across two calls', async () => {
      const reseller = await makeReseller();
      await brands.upsertBrand({}, reseller.id, { primaryColor: '#886644' });

      await expect(brands.upsertBrand({}, reseller.id, { accentColor: '#997755' })).rejects.toThrow(
        InsufficientContrastError,
      );
    });

    it('does not persist a rejected update', async () => {
      const reseller = await makeReseller();
      await brands.upsertBrand({}, reseller.id, { primaryColor: '#886644' });

      await expect(
        brands.upsertBrand({}, reseller.id, { accentColor: '#997755' }),
      ).rejects.toThrow();

      expect((await brands.findBrand(reseller.id))?.accentColor).toBeNull();
    });

    it('publishes org.brand.updated', async () => {
      const reseller = await makeReseller();

      await brands.upsertBrand({}, reseller.id, { displayName: 'Acme Voice' });

      const rows = await db.kysely
        .selectFrom('outbox')
        .selectAll()
        .where('type', '=', 'org.brand.updated')
        .execute();
      expect(rows).toHaveLength(1);
    });
  });

  describe('findBrand', () => {
    it('is undefined for a reseller with no brand configured', async () => {
      const reseller = await makeReseller();

      expect(await brands.findBrand(reseller.id)).toBeUndefined();
    });
  });

  describe('console hostnames', () => {
    it('registers a hostname for a reseller', async () => {
      const reseller = await makeReseller();

      const hostname = await brands.registerConsoleHostname(reseller.id, 'portal.acme-brand.com');

      expect(hostname).toEqual({
        fqdn: 'portal.acme-brand.com',
        resellerId: reseller.id,
        tlsStatus: 'pending',
      });
    });

    it('rejects an invalid fqdn', async () => {
      const reseller = await makeReseller();

      await expect(brands.registerConsoleHostname(reseller.id, 'not a hostname')).rejects.toThrow(
        InvalidFqdnError,
      );
    });

    it('rejects a duplicate hostname, including across resellers', async () => {
      const master = await orgs.createMaster({ slug: 'master', name: 'Master' });
      const resellerA = await orgs.create({}, 'reseller', {
        parentId: master.id,
        slug: 'reseller-a',
        name: 'A',
      });
      const resellerB = await orgs.create({}, 'reseller', {
        parentId: master.id,
        slug: 'reseller-b',
        name: 'B',
      });
      await brands.registerConsoleHostname(resellerA.id, 'portal.shared.example');

      await expect(
        brands.registerConsoleHostname(resellerB.id, 'portal.shared.example'),
      ).rejects.toThrow(ConsoleHostnameTakenError);
    });

    it("lists only the given reseller's hostnames", async () => {
      const master = await orgs.createMaster({ slug: 'master', name: 'Master' });
      const resellerA = await orgs.create({}, 'reseller', {
        parentId: master.id,
        slug: 'reseller-a',
        name: 'A',
      });
      const resellerB = await orgs.create({}, 'reseller', {
        parentId: master.id,
        slug: 'reseller-b',
        name: 'B',
      });
      await brands.registerConsoleHostname(resellerA.id, 'portal.a-brand.com');
      await brands.registerConsoleHostname(resellerB.id, 'portal.b-brand.com');

      const listed = await brands.listConsoleHostnames(resellerA.id);

      expect(listed.map((h) => h.fqdn)).toEqual(['portal.a-brand.com']);
    });

    it('finds the owning reseller for a registered hostname, and undefined for an unknown one', async () => {
      const reseller = await makeReseller();
      await brands.registerConsoleHostname(reseller.id, 'portal.acme-brand.com');

      expect(await brands.findResellerIdForHostname('portal.acme-brand.com')).toBe(reseller.id);
      expect(await brands.findResellerIdForHostname('portal.unknown.example')).toBeUndefined();
    });
  });
});
