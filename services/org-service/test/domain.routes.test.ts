import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { databaseOrSkipReason, silentLogger, startTestDatabase } from '@cuc/testing';
import { createServer, type Server } from '@cuc/http';

import type { DnsResolver } from '../src/dns-resolver.js';
import { createBrandRepo } from '../src/repo/brand.repo.js';
import { createDomainRepo, type DomainRepo } from '../src/repo/domain.repo.js';
import { createOrgRepo, type OrgRepo } from '../src/repo/org.repo.js';
import { registerDomainRoutes } from '../src/routes/domain.routes.js';
import { registerInternalRoutes } from '../src/routes/internal.routes.js';
import { migrations } from '../migrations/index.js';
import type { OrgServiceDb } from '../src/schema.js';

const skipReason = await databaseOrSkipReason();
const INTERNAL_TOKEN = 'test-internal-service-token';

/** A resolver whose answers are set per test, and swappable mid-test. */
function fakeResolver(): DnsResolver & { records: Record<string, string[][]> } {
  const state = {
    records: {} as Record<string, string[][]>,
    resolveTxt: (hostname: string): Promise<string[][]> => {
      const found = state.records[hostname];
      return found === undefined ? Promise.reject(new Error('ENOTFOUND')) : Promise.resolve(found);
    },
  };
  return state;
}

describe.skipIf(skipReason !== undefined)('domain-service HTTP routes', () => {
  let db: Database<OrgServiceDb>;
  let orgs: OrgRepo;
  let domainsRepo: DomainRepo;
  let app: Server;
  let resolver: ReturnType<typeof fakeResolver>;
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
    domainsRepo = createDomainRepo(db);
    resolver = fakeResolver();

    app = await createServer({ serviceName: 'org-service', logger });
    registerDomainRoutes(app, domainsRepo, resolver);
    registerInternalRoutes(app, domainsRepo, INTERNAL_TOKEN, orgs, createBrandRepo(db));
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
    resolver.records = {};
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

  describe('POST /v1/resellers/:id/base-domains', () => {
    it('registers a pending domain', async () => {
      const reseller = await makeReseller();

      const response = await app.inject({
        method: 'POST',
        url: `/v1/resellers/${reseller.id}/base-domains`,
        payload: { fqdn: 'voice.acme-brand.com' },
      });

      expect(response.statusCode).toBe(201);
      const body: { status: string; verificationToken: string; verificationRecordName: string } =
        response.json();
      expect(body).toMatchObject({
        status: 'pending',
        verificationRecordName: '_domain-verification.voice.acme-brand.com',
      });
      expect(body.verificationToken).toBeTruthy();
    });

    it('400s an invalid fqdn', async () => {
      const reseller = await makeReseller();

      const response = await app.inject({
        method: 'POST',
        url: `/v1/resellers/${reseller.id}/base-domains`,
        payload: { fqdn: 'not a domain' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('409s a duplicate domain', async () => {
      const reseller = await makeReseller();
      await app.inject({
        method: 'POST',
        url: `/v1/resellers/${reseller.id}/base-domains`,
        payload: { fqdn: 'voice.acme-brand.com' },
      });

      const response = await app.inject({
        method: 'POST',
        url: `/v1/resellers/${reseller.id}/base-domains`,
        payload: { fqdn: 'voice.acme-brand.com' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'domain_taken' });
    });
  });

  describe('POST /v1/resellers/:id/base-domains/:domainId/verify', () => {
    it('activates the domain once the TXT record is published', async () => {
      const reseller = await makeReseller();
      const registered = await app.inject({
        method: 'POST',
        url: `/v1/resellers/${reseller.id}/base-domains`,
        payload: { fqdn: 'voice.acme-brand.com' },
      });
      const body: { id: string; verificationToken: string; verificationRecordName: string } =
        registered.json();
      resolver.records[body.verificationRecordName] = [[body.verificationToken]];

      const response = await app.inject({
        method: 'POST',
        url: `/v1/resellers/${reseller.id}/base-domains/${body.id}/verify`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'active' });
    });

    it('409s when the TXT record is not there yet', async () => {
      const reseller = await makeReseller();
      const registered = await app.inject({
        method: 'POST',
        url: `/v1/resellers/${reseller.id}/base-domains`,
        payload: { fqdn: 'voice.acme-brand.com' },
      });
      const body: { id: string } = registered.json();

      const response = await app.inject({
        method: 'POST',
        url: `/v1/resellers/${reseller.id}/base-domains/${body.id}/verify`,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'domain_not_verified' });
    });

    it('404s an unknown domain id', async () => {
      const reseller = await makeReseller();

      const response = await app.inject({
        method: 'POST',
        url: `/v1/resellers/${reseller.id}/base-domains/no-such-domain/verify`,
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /v1/resellers/:id/base-domains', () => {
    it("lists only the named reseller's base domains", async () => {
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
      await app.inject({
        method: 'POST',
        url: `/v1/resellers/${resellerA.id}/base-domains`,
        payload: { fqdn: 'voice.a-brand.com' },
      });
      await app.inject({
        method: 'POST',
        url: `/v1/resellers/${resellerB.id}/base-domains`,
        payload: { fqdn: 'voice.b-brand.com' },
      });

      const response = await app.inject({
        method: 'GET',
        url: `/v1/resellers/${resellerA.id}/base-domains`,
      });

      const body: { rows: { fqdn: string }[] } = response.json();
      expect(body.rows.map((row) => row.fqdn)).toEqual(['voice.a-brand.com']);
    });
  });

  describe('GET /v1/tenants/:id/domain', () => {
    it("returns the tenant's primary domain, assigned at creation", async () => {
      const reseller = await makeReseller();
      const tenant = await orgs.create({}, 'tenant', {
        parentId: reseller.id,
        slug: 'widgets',
        name: 'Widgets',
      });

      const response = await app.inject({ method: 'GET', url: `/v1/tenants/${tenant.id}/domain` });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ fqdn: 'widgets.platform.test', isPrimary: true });
    });

    it('404s a tenant with no domain row (should not happen in practice, but the route is honest about it)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/tenants/no-such-tenant/domain',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /internal/v1/tenants/:id/domain', () => {
    it('rejects a request with no bearer token', async () => {
      const reseller = await makeReseller();
      const tenant = await orgs.create({}, 'tenant', {
        parentId: reseller.id,
        slug: 'widgets',
        name: 'Widgets',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenant.id}/domain`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('rejects a request with the wrong bearer token', async () => {
      const reseller = await makeReseller();
      const tenant = await orgs.create({}, 'tenant', {
        parentId: reseller.id,
        slug: 'widgets',
        name: 'Widgets',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenant.id}/domain`,
        headers: { authorization: 'Bearer not-the-token' },
      });

      expect(response.statusCode).toBe(401);
    });

    it("returns the tenant's primary domain with the right token", async () => {
      const reseller = await makeReseller();
      const tenant = await orgs.create({}, 'tenant', {
        parentId: reseller.id,
        slug: 'widgets',
        name: 'Widgets',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenant.id}/domain`,
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ fqdn: 'widgets.platform.test' });
    });

    it('404s a tenant with no primary domain', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/internal/v1/tenants/no-such-tenant/domain',
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /internal/v1/tenants/:id/reseller', () => {
    it('rejects a request with no bearer token', async () => {
      const reseller = await makeReseller();
      const tenant = await orgs.create({}, 'tenant', {
        parentId: reseller.id,
        slug: 'widgets',
        name: 'Widgets',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenant.id}/reseller`,
      });

      expect(response.statusCode).toBe(401);
    });

    it("returns the tenant's owning reseller with the right token", async () => {
      const reseller = await makeReseller();
      const tenant = await orgs.create({}, 'tenant', {
        parentId: reseller.id,
        slug: 'widgets',
        name: 'Widgets',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenant.id}/reseller`,
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ resellerId: reseller.id });
    });

    it('404s a reseller org id (not a tenant)', async () => {
      const reseller = await makeReseller();

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${reseller.id}/reseller`,
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it('404s an unknown tenant id', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/internal/v1/tenants/no-such-tenant/reseller',
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /internal/v1/tenants/:id/country', () => {
    it('rejects a request with no bearer token', async () => {
      const reseller = await makeReseller();
      const tenant = await orgs.create({}, 'tenant', {
        parentId: reseller.id,
        slug: 'widgets',
        name: 'Widgets',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenant.id}/country`,
      });

      expect(response.statusCode).toBe(401);
    });

    it("returns the tenant's country with the right token", async () => {
      const reseller = await makeReseller();
      const tenant = await orgs.create({}, 'tenant', {
        parentId: reseller.id,
        slug: 'widgets',
        name: 'Widgets',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenant.id}/country`,
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ country: 'US' });
    });

    it('404s a reseller org id (not a tenant)', async () => {
      const reseller = await makeReseller();

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${reseller.id}/country`,
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it('404s an unknown tenant id', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/internal/v1/tenants/no-such-tenant/country',
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /internal/v1/tenants/:id/limits', () => {
    it('rejects a request with no bearer token', async () => {
      const reseller = await makeReseller();
      const tenant = await orgs.create({}, 'tenant', {
        parentId: reseller.id,
        slug: 'widgets',
        name: 'Widgets',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenant.id}/limits`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns an empty bag for a freshly-created tenant', async () => {
      const reseller = await makeReseller();
      const tenant = await orgs.create({}, 'tenant', {
        parentId: reseller.id,
        slug: 'widgets',
        name: 'Widgets',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenant.id}/limits`,
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ limits: {} });
    });

    it("returns whatever's been set, passed through untyped", async () => {
      const reseller = await makeReseller();
      const tenant = await orgs.create({}, 'tenant', {
        parentId: reseller.id,
        slug: 'widgets',
        name: 'Widgets',
      });
      await orgs.update({}, tenant.id, {
        limits: { maxConcurrentChannels: 5, internationalAllowed: true },
      });

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenant.id}/limits`,
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        limits: { maxConcurrentChannels: 5, internationalAllowed: true },
      });
    });

    it('404s a reseller org id (not a tenant)', async () => {
      const reseller = await makeReseller();

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${reseller.id}/limits`,
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it('404s an unknown tenant id', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/internal/v1/tenants/no-such-tenant/limits',
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  it('every public route declares permission and dataClass (CLAUDE.md rule 3)', () => {
    for (const route of app.registeredRoutes) {
      if (route.url.startsWith('/v1/')) {
        expect(route.permission, `${route.method} ${route.url}`).not.toBeNull();
        expect(route.dataClass, `${route.method} ${route.url}`).not.toBeNull();
      }
    }
  });
});
