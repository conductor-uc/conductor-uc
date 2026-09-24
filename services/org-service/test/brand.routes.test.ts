import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import {
  databaseOrSkipReason,
  s3OrSkipReason,
  silentLogger,
  startTestDatabase,
  startTestS3,
  type TestS3Handle,
} from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';
import { createStorage, type Storage } from '@cuc/storage';

import { createBrandRepo, type BrandRepo } from '../src/repo/brand.repo.js';
import { createOrgRepo, type OrgRepo } from '../src/repo/org.repo.js';
import { registerBrandRoutes } from '../src/routes/brand.routes.js';
import { migrations } from '../migrations/index.js';
import type { OrgServiceDb } from '../src/schema.js';

const dbSkipReason = await databaseOrSkipReason();
const s3SkipReason = await s3OrSkipReason();
const skipReason = dbSkipReason ?? s3SkipReason;

const PLATFORM_CONSOLE_HOSTNAME = 'console.platform.test';
const TEST_INTERNAL_SECRET = 'test-internal-header-secret';

describe.skipIf(skipReason !== undefined)('brand-service HTTP routes', () => {
  let db: Database<OrgServiceDb>;
  let orgs: OrgRepo;
  let brandsRepo: BrandRepo;
  let app: Server;
  let s3Handle: TestS3Handle;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const logger = silentLogger();
    const dbHandle = await startTestDatabase();
    db = createDatabase<OrgServiceDb>({
      host: dbHandle.host,
      port: dbHandle.port,
      user: dbHandle.user,
      password: dbHandle.password,
      database: dbHandle.database,
      logger,
    });
    await migrateToLatest({ db: db.kysely, migrations, logger });
    orgs = createOrgRepo(db, { platformBaseDomain: 'platform.test' });
    brandsRepo = createBrandRepo(db);

    s3Handle = await startTestS3();
    const storage: Storage = createStorage({
      mode: 'bucket-per-tenant',
      bucketPrefix: `cuc-test-${randomUUID().slice(0, 8)}`,
      endpoint: s3Handle.endpoint,
      region: s3Handle.region,
      accessKeyId: s3Handle.accessKeyId,
      secretAccessKey: s3Handle.secretAccessKey,
      forcePathStyle: s3Handle.forcePathStyle,
      logger,
    });
    await storage.forPlatform().provisionBucket();

    app = await createServer({
      serviceName: 'org-service',
      logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: TEST_INTERNAL_SECRET },
    });
    registerBrandRoutes(app, brandsRepo, storage, PLATFORM_CONSOLE_HOSTNAME, orgs);
    await app.ready();

    stop = async () => {
      await app.close();
      await db.destroy();
      await dbHandle.stop();
      await s3Handle.stop();
    };
  });

  afterAll(async () => {
    await stop?.();
  });

  afterEach(async () => {
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

  describe('PUT /v1/resellers/:id/brand', () => {
    it('creates a brand', async () => {
      const reseller = await makeReseller();

      const response = await app.inject({
        method: 'PUT',
        url: `/v1/resellers/${reseller.id}/brand`,
        payload: { displayName: 'Acme Voice', primaryColor: '#000000', accentColor: '#ffffff' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ displayName: 'Acme Voice' });
    });

    it('400s an invalid color', async () => {
      const reseller = await makeReseller();

      const response = await app.inject({
        method: 'PUT',
        url: `/v1/resellers/${reseller.id}/brand`,
        payload: { primaryColor: 'not-a-color' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('400s an inaccessible color pair', async () => {
      const reseller = await makeReseller();

      const response = await app.inject({
        method: 'PUT',
        url: `/v1/resellers/${reseller.id}/brand`,
        payload: { primaryColor: '#886644', accentColor: '#997755' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'insufficient_contrast' });
    });
  });

  describe('GET /v1/resellers/:id/brand', () => {
    it('404s when no brand is configured', async () => {
      const reseller = await makeReseller();

      const response = await app.inject({
        method: 'GET',
        url: `/v1/resellers/${reseller.id}/brand`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns the brand once set', async () => {
      const reseller = await makeReseller();
      await app.inject({
        method: 'PUT',
        url: `/v1/resellers/${reseller.id}/brand`,
        payload: { displayName: 'Acme Voice' },
      });

      const response = await app.inject({
        method: 'GET',
        url: `/v1/resellers/${reseller.id}/brand`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ displayName: 'Acme Voice' });
    });
  });

  describe('brand assets', () => {
    it('issues a real presigned upload URL that actually accepts an upload', async () => {
      const reseller = await makeReseller();

      const response = await app.inject({
        method: 'POST',
        url: `/v1/resellers/${reseller.id}/brand/assets`,
        payload: { kind: 'logoLight', contentType: 'image/svg+xml' },
      });

      expect(response.statusCode).toBe(201);
      const body: { uploadUrl: string; key: string } = response.json();

      const uploadResponse = await fetch(body.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': 'image/svg+xml' },
        body: '<svg>acme</svg>',
      });
      expect(uploadResponse.ok).toBe(true);
    });
  });

  describe('console hostnames', () => {
    it('registers and lists a hostname', async () => {
      const reseller = await makeReseller();

      const register = await app.inject({
        method: 'POST',
        url: `/v1/resellers/${reseller.id}/console-hostnames`,
        payload: { fqdn: 'portal.acme-brand.com' },
      });
      expect(register.statusCode).toBe(201);

      const list = await app.inject({
        method: 'GET',
        url: `/v1/resellers/${reseller.id}/console-hostnames`,
      });
      const body: { rows: { fqdn: string }[] } = list.json();
      expect(body.rows.map((row) => row.fqdn)).toEqual(['portal.acme-brand.com']);
    });

    it('409s a duplicate hostname', async () => {
      const reseller = await makeReseller();
      await app.inject({
        method: 'POST',
        url: `/v1/resellers/${reseller.id}/console-hostnames`,
        payload: { fqdn: 'portal.acme-brand.com' },
      });

      const response = await app.inject({
        method: 'POST',
        url: `/v1/resellers/${reseller.id}/console-hostnames`,
        payload: { fqdn: 'portal.acme-brand.com' },
      });

      expect(response.statusCode).toBe(409);
    });
  });

  describe('GET /v1/public/brand — the four resolution branches', () => {
    it('branch 1: the master hostname is neutral', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/public/brand?host=${PLATFORM_CONSOLE_HOSTNAME}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ neutral: true });
    });

    it('branch 2: an unknown hostname is neutral', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/public/brand?host=nobody-registered-this.example',
      });

      expect(response.json()).toEqual({ neutral: true });
    });

    it('branch 3: a registered reseller hostname with no brand configured is neutral', async () => {
      const reseller = await makeReseller();
      await app.inject({
        method: 'POST',
        url: `/v1/resellers/${reseller.id}/console-hostnames`,
        payload: { fqdn: 'portal.no-brand.example' },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v1/public/brand?host=portal.no-brand.example',
      });

      expect(response.json()).toEqual({ neutral: true });
    });

    it('branch 4: a registered reseller hostname with a brand returns it, with real presigned asset URLs', async () => {
      const reseller = await makeReseller();
      await app.inject({
        method: 'POST',
        url: `/v1/resellers/${reseller.id}/console-hostnames`,
        payload: { fqdn: 'portal.acme-brand.com' },
      });
      const uploadRequest = await app.inject({
        method: 'POST',
        url: `/v1/resellers/${reseller.id}/brand/assets`,
        payload: { kind: 'logoLight', contentType: 'image/svg+xml' },
      });
      const asset: { uploadUrl: string; key: string } = uploadRequest.json();
      await fetch(asset.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': 'image/svg+xml' },
        body: '<svg>acme</svg>',
      });
      await app.inject({
        method: 'PUT',
        url: `/v1/resellers/${reseller.id}/brand`,
        payload: {
          displayName: 'Acme Voice',
          primaryColor: '#000000',
          accentColor: '#ffffff',
          logoLightKey: asset.key,
          supportEmail: 'help@acme.example',
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/v1/public/brand?host=portal.acme-brand.com',
      });

      expect(response.statusCode).toBe(200);
      const body: {
        neutral: boolean;
        displayName: string;
        logoLightUrl: string;
        supportEmail: string;
      } = response.json();
      expect(body).toMatchObject({
        neutral: false,
        displayName: 'Acme Voice',
        supportEmail: 'help@acme.example',
      });

      // The URL is a real, working presigned GET — not a bare key.
      const downloaded = await fetch(body.logoLightUrl);
      expect(await downloaded.text()).toBe('<svg>acme</svg>');
    });

    it('the neutral response contains no product name (S1-04 acceptance line)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/public/brand?host=${PLATFORM_CONSOLE_HOSTNAME}`,
      });

      expect(response.body.toLowerCase()).not.toMatch(/conductor|cuc/);
    });
  });

  it('every route declares permission and dataClass, except the public one (CLAUDE.md rule 3)', () => {
    for (const route of app.registeredRoutes) {
      if (!route.url.startsWith('/v1/')) continue;
      if (route.url === '/v1/public/brand') {
        expect(route.public).toBe(true);
        continue;
      }
      expect(route.permission, `${route.method} ${route.url}`).not.toBeNull();
      expect(route.dataClass, `${route.method} ${route.url}`).not.toBeNull();
    }
  });

  describe('GET /v1/session/brand', () => {
    function asOrg(orgId: string, orgType: 'master' | 'reseller' | 'tenant') {
      return signInternalHeaders(TEST_INTERNAL_SECRET, {
        actorId: 'user-1',
        actorType: 'user',
        orgId,
        orgType,
      });
    }

    async function branded() {
      const reseller = await makeReseller();
      const tenant = await orgs.create({}, 'tenant', {
        parentId: reseller.id,
        slug: 'dental',
        name: 'Dental',
      });
      await app.inject({
        method: 'PUT',
        url: `/v1/resellers/${reseller.id}/brand`,
        payload: { displayName: 'Acme Voice', primaryColor: '#4a148c', accentColor: '#ffe082' },
      });
      return { reseller, tenant };
    }

    it('gives a reseller its own brand', async () => {
      const { reseller } = await branded();
      const response = await app.inject({
        method: 'GET',
        url: '/v1/session/brand',
        headers: asOrg(reseller.id, 'reseller'),
      });
      expect(response.json()).toMatchObject({ neutral: false, displayName: 'Acme Voice' });
    });

    it("gives a tenant its reseller's brand", async () => {
      const { tenant } = await branded();
      const response = await app.inject({
        method: 'GET',
        url: '/v1/session/brand',
        headers: asOrg(tenant.id, 'tenant'),
      });
      expect(response.json()).toMatchObject({ neutral: false, displayName: 'Acme Voice' });
    });

    it('is neutral for the master, and for a reseller with no brand yet', async () => {
      const reseller = await makeReseller();
      const master = await orgs.findById(reseller.parentId ?? '');
      const asMaster = await app.inject({
        method: 'GET',
        url: '/v1/session/brand',
        headers: asOrg(master?.id ?? '', 'master'),
      });
      expect(asMaster.json()).toEqual({ neutral: true });
      const unbranded = await app.inject({
        method: 'GET',
        url: '/v1/session/brand',
        headers: asOrg(reseller.id, 'reseller'),
      });
      expect(unbranded.json()).toEqual({ neutral: true });
    });

    it('needs a signed-in actor', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/session/brand' });
      expect(response.statusCode).toBe(401);
    });
  });
});
