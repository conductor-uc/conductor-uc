import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fileKekFromConfig } from '@cuc/crypto';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';
import { databaseOrSkipReason, silentLogger, startTestDatabase } from '@cuc/testing';

import { createCertificateRepo, type CertificateRepo } from '../src/repo/certificate.repo.js';
import { createOrgRepo, type OrgRepo } from '../src/repo/org.repo.js';
import {
  registerCertificateInternalRoutes,
  registerCertificateRoutes,
} from '../src/routes/certificate.routes.js';
import type { OrgServiceDb } from '../src/schema.js';
import { migrations } from '../migrations/index.js';
import { makeCertificate } from './certs.js';

const skipReason = await databaseOrSkipReason();
const SECRET = 'test-internal-header-secret';
const TOKEN = 'test-internal-service-token';
const bearer = { authorization: `Bearer ${TOKEN}` };

describe.skipIf(skipReason !== undefined)('certificate routes', () => {
  let db: Database<OrgServiceDb>;
  let certs: CertificateRepo;
  let orgs: OrgRepo;
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
    certs = createCertificateRepo(db, {
      kek: fileKekFromConfig({
        CRYPTO_KEKS: `1:${randomBytes(32).toString('base64')}`,
        CRYPTO_KEK_CURRENT: '1',
      }),
      platformBaseDomain: 'platform.test',
    });
    orgs = createOrgRepo(db, { platformBaseDomain: 'platform.test' });
    app = await createServer({
      serviceName: 'org-service',
      logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
    });
    registerCertificateRoutes(app, certs);
    registerCertificateInternalRoutes(app, certs, TOKEN);
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

  beforeEach(async () => {
    await db.kysely.deleteFrom('acme_challenges').execute();
    await db.kysely.deleteFrom('tls_certificates').execute();
    await db.kysely.deleteFrom('tenant_domains').execute();
    await db.kysely.deleteFrom('reseller_base_domains').execute();
    await db.kysely.deleteFrom('orgs').where('type', '=', 'tenant').execute();
    await db.kysely.deleteFrom('orgs').where('type', '=', 'reseller').execute();
    await db.kysely.deleteFrom('orgs').where('type', '=', 'master').execute();
    await db.kysely.deleteFrom('outbox').execute();
  });

  const actor = (orgId: string, orgType: 'master' | 'reseller') =>
    signInternalHeaders(SECRET, { actorId: 'user-1', actorType: 'user', orgId, orgType });

  describe('the console views', () => {
    it("lists a reseller's certificates, with the reason one is failing", async () => {
      const master = await orgs.createMaster({ slug: 'master', name: 'Master' });
      const reseller = await orgs.create({}, 'reseller', {
        parentId: master.id,
        slug: 'acme',
        name: 'Acme',
      });
      const now = new Date();
      await db.kysely
        .insertInto('reseller_base_domains')
        .values({
          id: crypto.randomUUID(),
          reseller_id: reseller.id,
          fqdn: 'voice.reseller-brand.com',
          verification_token: 't',
          verified_at: now,
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        .execute();
      await certs.reconcileWanted();
      await certs.recordFailure(
        'sip.voice.reseller-brand.com',
        'No A record for sip.voice.reseller-brand.com',
      );

      const response = await app.inject({
        method: 'GET',
        url: `/v1/resellers/${reseller.id}/certificates`,
        headers: actor(reseller.id, 'reseller'),
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<{ rows: unknown[] }>().rows).toEqual([
        expect.objectContaining({
          fqdn: 'sip.voice.reseller-brand.com',
          purpose: 'sip',
          status: 'failed',
          lastError: 'No A record for sip.voice.reseller-brand.com',
          attempts: 1,
          notAfter: null,
        }),
      ]);
      expect(response.body).not.toContain('PRIVATE KEY');
    });

    it("shows the platform's own certificates to the master only", async () => {
      const master = await orgs.createMaster({ slug: 'master', name: 'Master' });
      const reseller = await orgs.create({}, 'reseller', {
        parentId: master.id,
        slug: 'acme',
        name: 'Acme',
      });
      await certs.reconcileWanted();

      const asMaster = await app.inject({
        method: 'GET',
        url: '/v1/platform/certificates',
        headers: actor(master.id, 'master'),
      });
      expect(asMaster.statusCode).toBe(200);
      expect(asMaster.json<{ rows: { fqdn: string }[] }>().rows.map((r) => r.fqdn)).toEqual([
        'console.platform.test',
        'sip.platform.test',
      ]);

      const asReseller = await app.inject({
        method: 'GET',
        url: '/v1/platform/certificates',
        headers: actor(reseller.id, 'reseller'),
      });
      expect(asReseller.statusCode).toBe(403);
    });
  });

  describe('service to service', () => {
    it('refuses every internal route without the service token', async () => {
      for (const url of [
        `/internal/v1/tenants/${crypto.randomUUID()}/sip-proxy`,
        '/internal/v1/certificates/sip.platform.test',
        '/internal/v1/certificates?purpose=sip',
        '/internal/v1/acme/challenges/abc',
      ]) {
        expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
        expect(
          (await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer wrong' } }))
            .statusCode,
          url,
        ).toBe(401);
      }
    });

    it("tells a tenant's phones which proxy to connect to", async () => {
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
      await certs.reconcileWanted();

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenant.id}/sip-proxy`,
        headers: bearer,
      });
      expect(response.json()).toEqual({ host: 'sip.platform.test', status: 'pending' });

      const missing = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${crypto.randomUUID()}/sip-proxy`,
        headers: bearer,
      });
      expect(missing.statusCode).toBe(404);
    });

    it('hands a consumer the certificate and its key, uncached, once one is held', async () => {
      await certs.reconcileWanted();
      const pending = await app.inject({
        method: 'GET',
        url: '/internal/v1/certificates/sip.platform.test',
        headers: bearer,
      });
      expect(pending.statusCode).toBe(404);

      const c = makeCertificate(['sip.platform.test']);
      await certs.storeIssued({
        fqdn: 'sip.platform.test',
        certificatePem: c.certificate,
        privateKeyPem: c.key,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/internal/v1/certificates/SIP.platform.test',
        headers: bearer,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toMatchObject({
        fqdn: 'sip.platform.test',
        purpose: 'sip',
        resellerId: null,
        version: 1,
        certificate: c.certificate,
        privateKey: c.key,
      });
    });

    it('lists the held certificates without their keys, for a consumer to compare against', async () => {
      await certs.reconcileWanted();
      const c = makeCertificate(['sip.platform.test']);
      await certs.storeIssued({
        fqdn: 'sip.platform.test',
        certificatePem: c.certificate,
        privateKeyPem: c.key,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/internal/v1/certificates?purpose=sip',
        headers: bearer,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<{ rows: unknown[] }>().rows).toEqual([
        expect.objectContaining({
          fqdn: 'sip.platform.test',
          purpose: 'sip',
          resellerId: null,
          version: 1,
        }),
      ]);
      expect(response.body).not.toContain('PRIVATE KEY');
      const bad = await app.inject({
        method: 'GET',
        url: '/internal/v1/certificates?purpose=other',
        headers: bearer,
      });
      expect(bad.statusCode).toBe(400);
    });

    it('serves the answer to an HTTP challenge while it is valid', async () => {
      await certs.putChallenge({
        token: 'tok-abc',
        fqdn: 'sip.platform.test',
        keyAuthorization: 'tok-abc.thumbprint',
        expiresAt: new Date(Date.now() + 60_000),
      });
      const ok = await app.inject({
        method: 'GET',
        url: '/internal/v1/acme/challenges/tok-abc',
        headers: bearer,
      });
      expect(ok.json()).toEqual({ keyAuthorization: 'tok-abc.thumbprint' });
      const unknown = await app.inject({
        method: 'GET',
        url: '/internal/v1/acme/challenges/other',
        headers: bearer,
      });
      expect(unknown.statusCode).toBe(404);
    });
  });
});
