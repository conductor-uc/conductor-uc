import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fileKekFromConfig } from '@cuc/crypto';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { databaseOrSkipReason, silentLogger, startTestDatabase } from '@cuc/testing';

import { RENEW_BEFORE_MS } from '../src/domain/certificates.js';
import { InvalidCertificateError } from '../src/domain/certificates.js';
import {
  CertificateNotFoundError,
  createCertificateRepo,
  type CertificateRepo,
} from '../src/repo/certificate.repo.js';
import { createDomainRepo } from '../src/repo/domain.repo.js';
import { createOrgRepo, type OrgRepo } from '../src/repo/org.repo.js';
import type { OrgServiceDb } from '../src/schema.js';
import { migrations } from '../migrations/index.js';
import { makeCertificate } from './certs.js';

const skipReason = await databaseOrSkipReason();
const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(skipReason !== undefined)('certificate repo', () => {
  let db: Database<OrgServiceDb>;
  let certs: CertificateRepo;
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
    certs = createCertificateRepo(db, {
      kek: fileKekFromConfig({
        CRYPTO_KEKS: `1:${randomBytes(32).toString('base64')}`,
        CRYPTO_KEK_CURRENT: '1',
      }),
      platformBaseDomain: 'platform.test',
    });
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
    await db.kysely.deleteFrom('acme_challenges').execute();
    await db.kysely.deleteFrom('tls_certificates').execute();
    await db.kysely.deleteFrom('console_hostnames').execute();
    await db.kysely.deleteFrom('tenant_domains').execute();
    await db.kysely.deleteFrom('reseller_base_domains').execute();
    await db.kysely.deleteFrom('orgs').where('type', '=', 'tenant').execute();
    await db.kysely.deleteFrom('orgs').where('type', '=', 'reseller').execute();
    await db.kysely.deleteFrom('orgs').where('type', '=', 'master').execute();
    await db.kysely.deleteFrom('outbox').execute();
  });

  async function makeReseller(slug = 'acme') {
    const master = await orgs.createMaster({ slug: `m-${slug}`, name: 'Master' });
    return orgs.create({}, 'reseller', { parentId: master.id, slug, name: slug });
  }

  /** An active base domain for [reseller], put straight in the table (verification has its own tests). */
  async function activeBase(resellerId: string, fqdn: string) {
    const now = new Date();
    await db.kysely
      .insertInto('reseller_base_domains')
      .values({
        id: crypto.randomUUID(),
        reseller_id: resellerId,
        fqdn,
        verification_token: 't',
        verified_at: now,
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  describe('reconcileWanted', () => {
    it("wants the platform's proxy and console, and nothing else, to begin with", async () => {
      expect(await certs.reconcileWanted()).toBe(2);
      const rows = await certs.list({ resellerId: null });
      expect(rows.map((r) => [r.fqdn, r.purpose, r.status])).toEqual([
        ['console.platform.test', 'console', 'pending'],
        ['sip.platform.test', 'sip', 'pending'],
      ]);
    });

    it('adds sip.<base> for each active base domain, but not for a pending one', async () => {
      const reseller = await makeReseller();
      await activeBase(reseller.id, 'voice.reseller-brand.com');
      await createDomainRepo(db).registerBaseDomain(reseller.id, 'pending.example.com');

      await certs.reconcileWanted();

      const rows = await certs.list({ resellerId: reseller.id });
      expect(rows.map((r) => r.fqdn)).toEqual(['sip.voice.reseller-brand.com']);
      expect(rows[0]).toMatchObject({ purpose: 'sip', resellerId: reseller.id });
    });

    it("adds a reseller's console hostnames", async () => {
      const reseller = await makeReseller();
      await db.kysely
        .insertInto('console_hostnames')
        .values({
          fqdn: 'Portal.Reseller-Brand.com',
          reseller_id: reseller.id,
          tls_status: 'pending',
          created_at: new Date(),
        })
        .execute();

      await certs.reconcileWanted();

      expect(
        (await certs.list({ resellerId: reseller.id })).map((r) => [r.fqdn, r.purpose]),
      ).toEqual([['portal.reseller-brand.com', 'console']]);
    });

    it('is idempotent, and leaves a row it already has alone', async () => {
      await certs.reconcileWanted();
      const before = await certs.find('sip.platform.test');
      expect(await certs.reconcileWanted()).toBe(0);
      expect((await certs.find('sip.platform.test'))?.nextAttemptAt).toEqual(before?.nextAttemptAt);
    });
  });

  describe('claimDue', () => {
    it('takes what is due once, and not again until its lease runs out', async () => {
      await certs.reconcileWanted();
      const now = new Date();
      const first = await certs.claimDue(now, 10 * 60_000, 10);
      expect(first).toHaveLength(2);
      expect(await certs.claimDue(now, 10 * 60_000, 10)).toEqual([]);
      const later = new Date(now.getTime() + 11 * 60_000);
      expect(await certs.claimDue(later, 10 * 60_000, 10)).toHaveLength(2);
    });

    it('respects the limit', async () => {
      await certs.reconcileWanted();
      expect(await certs.claimDue(new Date(), 60_000, 1)).toHaveLength(1);
    });
  });

  describe('storeIssued', () => {
    it('keeps the certificate, encrypts the key, and hands both back through getMaterial', async () => {
      await certs.reconcileWanted();
      const c = makeCertificate(['sip.platform.test']);

      const stored = await certs.storeIssued({
        fqdn: 'sip.platform.test',
        certificatePem: c.certificate,
        privateKeyPem: c.key,
      });

      expect(stored).toMatchObject({ status: 'active', version: 1, attempts: 0, lastError: null });
      const raw = await db.kysely
        .selectFrom('tls_certificates')
        .selectAll()
        .where('fqdn', '=', 'sip.platform.test')
        .executeTakeFirstOrThrow();
      expect(raw.private_key_enc).not.toContain('PRIVATE KEY');
      expect(raw.private_key_enc).not.toContain(c.key.trim().split('\n')[1] ?? 'x');
      expect(raw.certificate_pem).toBe(c.certificate);

      const material = await certs.getMaterial('sip.platform.test');
      expect(material?.privateKeyPem).toBe(c.key);
      expect(material?.certificatePem).toBe(c.certificate);
      expect(material?.version).toBe(1);
    });

    it('sets the renewal time a month before expiry, and bumps the version each time', async () => {
      await certs.reconcileWanted();
      const first = makeCertificate(['sip.platform.test'], 60);
      const stored = await certs.storeIssued({
        fqdn: 'sip.platform.test',
        certificatePem: first.certificate,
        privateKeyPem: first.key,
      });
      expect(stored.nextAttemptAt.getTime()).toBe(
        (stored.notAfter?.getTime() ?? 0) - RENEW_BEFORE_MS,
      );

      const second = makeCertificate(['sip.platform.test'], 60);
      const renewed = await certs.storeIssued({
        fqdn: 'sip.platform.test',
        certificatePem: second.certificate,
        privateKeyPem: second.key,
      });
      expect(renewed.version).toBe(2);
    });

    it('queues org.certificate.issued in the same transaction, and puts no key on it', async () => {
      const reseller = await makeReseller();
      await activeBase(reseller.id, 'voice.reseller-brand.com');
      await certs.reconcileWanted();
      const c = makeCertificate(['sip.voice.reseller-brand.com']);

      await certs.storeIssued({
        fqdn: 'sip.voice.reseller-brand.com',
        certificatePem: c.certificate,
        privateKeyPem: c.key,
      });

      const events = await db.kysely
        .selectFrom('outbox')
        .selectAll()
        .where('type', '=', 'org.certificate.issued')
        .execute();
      expect(events).toHaveLength(1);
      const body = JSON.stringify(events[0]);
      expect(body).toContain('sip.voice.reseller-brand.com');
      expect(body).not.toContain('PRIVATE KEY');
      expect(body).not.toContain(c.key.trim().split('\n')[1] ?? 'x');
    });

    it("marks the console hostname's status active", async () => {
      const reseller = await makeReseller();
      await db.kysely
        .insertInto('console_hostnames')
        .values({
          fqdn: 'portal.reseller-brand.com',
          reseller_id: reseller.id,
          tls_status: 'pending',
          created_at: new Date(),
        })
        .execute();
      await certs.reconcileWanted();
      const c = makeCertificate(['portal.reseller-brand.com']);

      await certs.storeIssued({
        fqdn: 'portal.reseller-brand.com',
        certificatePem: c.certificate,
        privateKeyPem: c.key,
      });

      const host = await db.kysely
        .selectFrom('console_hostnames')
        .select('tls_status')
        .where('fqdn', '=', 'portal.reseller-brand.com')
        .executeTakeFirstOrThrow();
      expect(host.tls_status).toBe('active');
    });

    it('refuses a certificate for another name, a mismatched key, and a hostname nobody wanted', async () => {
      await certs.reconcileWanted();
      const c = makeCertificate(['sip.platform.test']);
      const other = makeCertificate(['sip.platform.test']);

      await expect(
        certs.storeIssued({
          fqdn: 'console.platform.test',
          certificatePem: c.certificate,
          privateKeyPem: c.key,
        }),
      ).rejects.toBeInstanceOf(InvalidCertificateError);
      await expect(
        certs.storeIssued({
          fqdn: 'sip.platform.test',
          certificatePem: c.certificate,
          privateKeyPem: other.key,
        }),
      ).rejects.toBeInstanceOf(InvalidCertificateError);
      const stranger = makeCertificate(['sip.unknown.test']);
      await expect(
        certs.storeIssued({
          fqdn: 'sip.unknown.test',
          certificatePem: stranger.certificate,
          privateKeyPem: stranger.key,
        }),
      ).rejects.toBeInstanceOf(CertificateNotFoundError);
      expect(await certs.getMaterial('sip.platform.test')).toBeUndefined();
    });

    it('gives no material while a certificate is still pending', async () => {
      await certs.reconcileWanted();
      expect(await certs.getMaterial('sip.platform.test')).toBeUndefined();
    });
  });

  describe('recordFailure', () => {
    it('marks a never-issued certificate failed, remembers why, and backs off', async () => {
      await certs.reconcileWanted();
      const now = new Date();
      await certs.recordFailure('sip.platform.test', 'DNS did not resolve', now);
      const one = await certs.find('sip.platform.test');
      expect(one).toMatchObject({
        status: 'failed',
        attempts: 1,
        lastError: 'DNS did not resolve',
      });
      expect(one?.nextAttemptAt.getTime()).toBe(now.getTime() + 60_000);

      await certs.recordFailure('sip.platform.test', 'still not', now);
      expect((await certs.find('sip.platform.test'))?.nextAttemptAt.getTime()).toBe(
        now.getTime() + 5 * 60_000,
      );
    });

    it('leaves a certificate we already hold active when a renewal fails', async () => {
      await certs.reconcileWanted();
      const c = makeCertificate(['sip.platform.test']);
      await certs.storeIssued({
        fqdn: 'sip.platform.test',
        certificatePem: c.certificate,
        privateKeyPem: c.key,
      });

      await certs.recordFailure('sip.platform.test', 'CA unreachable');

      expect(await certs.find('sip.platform.test')).toMatchObject({
        status: 'active',
        attempts: 1,
      });
      expect(await certs.getMaterial('sip.platform.test')).toBeDefined();
    });

    it('marks a console hostname failed too, and quietly ignores a name it does not know', async () => {
      const reseller = await makeReseller();
      await db.kysely
        .insertInto('console_hostnames')
        .values({
          fqdn: 'portal.reseller-brand.com',
          reseller_id: reseller.id,
          tls_status: 'pending',
          created_at: new Date(),
        })
        .execute();
      await certs.reconcileWanted();
      await certs.recordFailure('portal.reseller-brand.com', 'no A record');
      const host = await db.kysely
        .selectFrom('console_hostnames')
        .select('tls_status')
        .where('fqdn', '=', 'portal.reseller-brand.com')
        .executeTakeFirstOrThrow();
      expect(host.tls_status).toBe('failed');
      await expect(certs.recordFailure('nobody.test', 'x')).resolves.toBeUndefined();
    });
  });

  describe('sipProxyFor', () => {
    it("is the reseller's own proxy for a tenant under its base domain", async () => {
      const reseller = await makeReseller();
      await activeBase(reseller.id, 'voice.reseller-brand.com');
      const tenant = await orgs.create({}, 'tenant', {
        parentId: reseller.id,
        slug: 'dental',
        name: 'Dental',
      });
      await certs.reconcileWanted();

      expect(await certs.sipProxyFor(tenant.id)).toEqual({
        host: 'sip.voice.reseller-brand.com',
        status: 'pending',
      });
    });

    it("is the platform's proxy for a reseller with no base domain, and reports its status", async () => {
      const reseller = await makeReseller();
      const tenant = await orgs.create({}, 'tenant', {
        parentId: reseller.id,
        slug: 'dental',
        name: 'Dental',
      });
      await certs.reconcileWanted();
      const c = makeCertificate(['sip.platform.test']);
      await certs.storeIssued({
        fqdn: 'sip.platform.test',
        certificatePem: c.certificate,
        privateKeyPem: c.key,
      });

      expect(await certs.sipProxyFor(tenant.id)).toEqual({
        host: 'sip.platform.test',
        status: 'active',
      });
    });

    it('is undefined for a tenant that does not exist', async () => {
      expect(await certs.sipProxyFor(crypto.randomUUID())).toBeUndefined();
    });
  });

  describe('challenges', () => {
    it('are served until they expire, then purged', async () => {
      const now = new Date();
      await certs.putChallenge({
        token: 'tok-1',
        fqdn: 'SIP.platform.test',
        keyAuthorization: 'tok-1.thumb',
        expiresAt: new Date(now.getTime() + 60_000),
        now,
      });
      expect(await certs.getChallenge('tok-1', now)).toBe('tok-1.thumb');
      expect(await certs.getChallenge('tok-1', new Date(now.getTime() + 120_000))).toBeUndefined();
      expect(await certs.getChallenge('nope', now)).toBeUndefined();

      expect(await certs.purgeExpiredChallenges(new Date(now.getTime() + 120_000))).toBe(1);
      await certs.putChallenge({
        token: 'tok-2',
        fqdn: 'a.test',
        keyAuthorization: 'x',
        expiresAt: new Date(now.getTime() + DAY),
        now,
      });
      await certs.deleteChallenge('tok-2');
      expect(await certs.getChallenge('tok-2', now)).toBeUndefined();
    });

    it('replace an earlier answer for the same token', async () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60_000);
      await certs.putChallenge({
        token: 't',
        fqdn: 'a.test',
        keyAuthorization: 'one',
        expiresAt,
        now,
      });
      await certs.putChallenge({
        token: 't',
        fqdn: 'a.test',
        keyAuthorization: 'two',
        expiresAt,
        now,
      });
      expect(await certs.getChallenge('t', now)).toBe('two');
    });
  });
});
