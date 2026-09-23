import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { databaseOrSkipReason, silentLogger, startTestDatabase } from '@cuc/testing';
import { createServer, type Server } from '@cuc/http';

import { createBrandRepo, type BrandRepo } from '../src/repo/brand.repo.js';
import { createDomainRepo } from '../src/repo/domain.repo.js';
import { createOrgRepo, type OrgRepo } from '../src/repo/org.repo.js';
import { registerInternalRoutes } from '../src/routes/internal.routes.js';
import { migrations } from '../migrations/index.js';
import type { OrgServiceDb } from '../src/schema.js';

const skipReason = await databaseOrSkipReason();
const INTERNAL_TOKEN = 'test-internal-service-token';
interface MailBrandBody {
  neutral: boolean;
  displayName: string | null;
  consoleHostname: string | null;
}

const AUTH = { authorization: `Bearer ${INTERNAL_TOKEN}` };

describe.skipIf(skipReason !== undefined)('GET /internal/v1/orgs/:id/mail-brand', () => {
  let db: Database<OrgServiceDb>;
  let orgs: OrgRepo;
  let brands: BrandRepo;
  let app: Server;
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
    orgs = createOrgRepo(db, { platformBaseDomain: 'platform.test' });
    brands = createBrandRepo(db);

    app = await createServer({ serviceName: 'org-service', logger });
    registerInternalRoutes(app, createDomainRepo(db), INTERNAL_TOKEN, orgs, brands);
    await app.ready();

    stop = async () => {
      await app.close();
      await db.destroy();
      await handle.stop();
    };
  });

  afterAll(async () => {
    await stop?.();
  });

  afterEach(async () => {
    await db.kysely.deleteFrom('tenant_domains').execute();
    await db.kysely.deleteFrom('reseller_base_domains').execute();
    await db.kysely.deleteFrom('console_hostnames').execute();
    await db.kysely.deleteFrom('brands').execute();
    await db.kysely.deleteFrom('orgs').where('type', '=', 'tenant').execute();
    await db.kysely.deleteFrom('orgs').where('type', '=', 'reseller').execute();
    await db.kysely.deleteFrom('orgs').where('type', '=', 'master').execute();
    await db.kysely.deleteFrom('outbox').execute();
  });

  async function tree() {
    const master = await orgs.createMaster({ slug: 'master', name: 'Master' });
    const reseller = await orgs.create({}, 'reseller', {
      parentId: master.id,
      slug: 'acme',
      name: 'Acme',
    });
    const tenant = await orgs.create({}, 'tenant', {
      parentId: reseller.id,
      slug: 'dental',
      name: 'Dental',
    });
    return { master, reseller, tenant };
  }

  const get = (id: string, headers: Record<string, string> = AUTH) =>
    app.inject({ method: 'GET', url: `/internal/v1/orgs/${id}/mail-brand`, headers });

  it('requires the internal service token', async () => {
    const { master } = await tree();
    expect((await get(master.id, {})).statusCode).toBe(401);
    expect((await get(master.id, { authorization: 'Bearer nope' })).statusCode).toBe(401);
  });

  it('404s an unknown org', async () => {
    expect((await get(crypto.randomUUID())).statusCode).toBe(404);
  });

  it('gives the master no brand and no hostname', async () => {
    const { master } = await tree();
    const body = (await get(master.id)).json<MailBrandBody>();
    expect(body).toMatchObject({ neutral: true, displayName: null, consoleHostname: null });
  });

  it('is neutral for a reseller with no brand, but still names its console host', async () => {
    const { reseller } = await tree();
    await brands.registerConsoleHostname(reseller.id, 'portal.acme.example');
    const body = (await get(reseller.id)).json<MailBrandBody>();
    expect(body).toMatchObject({
      neutral: true,
      displayName: null,
      consoleHostname: 'portal.acme.example',
    });
  });

  it("gives a reseller its own brand, and a tenant its reseller's", async () => {
    const { reseller, tenant } = await tree();
    await brands.upsertBrand({}, reseller.id, {
      displayName: 'Acme Voice',
      primaryColor: '#4a148c',
      accentColor: '#ffe082',
      emailFromName: 'Acme Voice',
      legalFooter: 'Acme Voice Ltd.',
    });
    await brands.registerConsoleHostname(reseller.id, 'portal.acme.example');

    for (const id of [reseller.id, tenant.id]) {
      expect((await get(id)).json()).toMatchObject({
        neutral: false,
        displayName: 'Acme Voice',
        primaryColor: '#4a148c',
        emailFromName: 'Acme Voice',
        legalFooter: 'Acme Voice Ltd.',
        consoleHostname: 'portal.acme.example',
      });
    }
  });

  it("never leaks one reseller's brand to another reseller's tenant", async () => {
    const { master, reseller } = await tree();
    const other = await orgs.create({}, 'reseller', {
      parentId: master.id,
      slug: 'other',
      name: 'Other',
    });
    const otherTenant = await orgs.create({}, 'tenant', {
      parentId: other.id,
      slug: 'shop',
      name: 'Shop',
    });
    await brands.upsertBrand({}, reseller.id, { displayName: 'Acme Voice' });

    expect((await get(otherTenant.id)).json()).toMatchObject({
      neutral: true,
      displayName: null,
    });
  });
});
