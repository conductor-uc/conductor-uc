import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fileKekFromConfig } from '@cuc/crypto';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { databaseOrSkipReason, silentLogger, startTestDatabase } from '@cuc/testing';

import type { AcmeIssuer, IssueRequest } from '../src/acme-issuer.js';
import { createCertificateWorker } from '../src/certificate-worker.js';
import { createAcmeAccountRepo } from '../src/repo/acme-account.repo.js';
import { createAcmeSettingsRepo } from '../src/repo/acme-settings.repo.js';
import { createCertificateRepo, type CertificateRepo } from '../src/repo/certificate.repo.js';
import type { OrgServiceDb } from '../src/schema.js';
import { migrations } from '../migrations/index.js';
import { makeCertificate } from './certs.js';

const skipReason = await databaseOrSkipReason();
const TERMS = 'https://letsencrypt.org/documents/LE-SA-v9.9.pdf';

/** A CA that is not one: it publishes the challenge as a real one would, then answers with a self-signed certificate. */
function fakeIssuer(
  behaviour: (request: IssueRequest) => void | Promise<void> = () => undefined,
): AcmeIssuer & { requests: IssueRequest[]; newKeys: number; challengesSeen: string[] } {
  const requests: IssueRequest[] = [];
  const challengesSeen: string[] = [];
  const issuer = {
    requests,
    challengesSeen,
    newKeys: 0,
    newAccountKey() {
      issuer.newKeys += 1;
      return Promise.resolve(
        `-----BEGIN PRIVATE KEY-----\nfake-account-key-${String(issuer.newKeys)}\n-----END PRIVATE KEY-----\n`,
      );
    },
    async issue(request: IssueRequest) {
      requests.push(request);
      await request.publishChallenge(`token-${request.fqdn}`, `token-${request.fqdn}.thumb`);
      challengesSeen.push(`token-${request.fqdn}`);
      await behaviour(request);
      await request.removeChallenge(`token-${request.fqdn}`);
      const c = makeCertificate([request.fqdn]);
      return {
        certificatePem: c.certificate,
        privateKeyPem: c.key,
        accountUrl: 'https://acme.test/acct/1',
      };
    },
  };
  return issuer;
}

describe.skipIf(skipReason !== undefined)('certificate worker', () => {
  let db: Database<OrgServiceDb>;
  let certs: CertificateRepo;
  let stop: () => Promise<void>;
  const settings = () => createAcmeSettingsRepo(db);
  let accounts: ReturnType<typeof createAcmeAccountRepo>;

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
    const kek = fileKekFromConfig({
      CRYPTO_KEKS: `1:${randomBytes(32).toString('base64')}`,
      CRYPTO_KEK_CURRENT: '1',
    });
    certs = createCertificateRepo(db, { kek, platformBaseDomain: 'platform.test' });
    accounts = createAcmeAccountRepo(db, kek);
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
    await db.kysely.deleteFrom('acme_accounts').execute();
    await db.kysely.deleteFrom('acme_settings').execute();
    await db.kysely.deleteFrom('tls_certificates').execute();
    await db.kysely.deleteFrom('outbox').execute();
    await certs.reconcileWanted();
  });

  async function setUp(directory: 'production' | 'staging' = 'production') {
    await settings().save({
      contactEmail: 'certs@example.test',
      directory,
      agreeToTerms: true,
      termsUrl: TERMS,
      actorId: 'user-1',
    });
  }

  function worker(issuer: AcmeIssuer, extra: { now?: () => Date } = {}) {
    return createCertificateWorker({
      certs,
      settings: settings(),
      accounts,
      issuer,
      logger: silentLogger(),
      ...extra,
    });
  }

  it('requests nothing until an address is saved and the terms are agreed', async () => {
    const issuer = fakeIssuer();
    const pass = await worker(issuer).runOnce();
    expect(pass.skipped).toMatch(/terms/);
    expect(issuer.requests).toEqual([]);

    await settings().save({
      contactEmail: 'certs@example.test',
      directory: 'production',
      agreeToTerms: false,
      termsUrl: null,
      actorId: 'u',
    });
    expect((await worker(issuer).runOnce()).skipped).not.toBeNull();
    expect(issuer.requests).toEqual([]);
    // Nothing was leased either, so the moment it is set up they are still due.
    await setUp();
    expect((await worker(issuer).runOnce()).issued).toHaveLength(2);
  });

  it("issues what is due under the operator's address, and stores it with its key", async () => {
    await setUp();
    const issuer = fakeIssuer();

    const pass = await worker(issuer).runOnce();

    expect(pass.failed).toEqual([]);
    expect([...pass.issued].sort()).toEqual(['console.platform.test', 'sip.platform.test']);
    expect(issuer.requests.every((r) => r.contactEmail === 'certs@example.test')).toBe(true);
    expect(
      issuer.requests.every(
        (r) => r.directoryUrl === 'https://acme-v02.api.letsencrypt.org/directory',
      ),
    ).toBe(true);
    const sip = await certs.getMaterial('sip.platform.test');
    expect(sip?.certificatePem).toContain('BEGIN CERTIFICATE');
    expect(sip?.privateKeyPem).toContain('PRIVATE KEY');
    expect((await certs.find('sip.platform.test'))?.status).toBe('active');
    const events = await db.kysely
      .selectFrom('outbox')
      .select('type')
      .where('type', '=', 'org.certificate.issued')
      .execute();
    expect(events).toHaveLength(2);
  });

  it('serves the challenge answer while the CA checks, and takes it away afterwards', async () => {
    await setUp();
    let visibleDuring: string | undefined;
    const issuer = fakeIssuer(async (request) => {
      visibleDuring = await certs.getChallenge(`token-${request.fqdn}`);
    });
    await worker(issuer).runOnce();
    expect(visibleDuring).toMatch(/\.thumb$/);
    expect(await certs.getChallenge('token-sip.platform.test')).toBeUndefined();
  });

  it('registers one account and reuses it, remembering its address', async () => {
    await setUp();
    const issuer = fakeIssuer();
    await worker(issuer).runOnce();
    expect(issuer.newKeys).toBe(1);
    expect(issuer.requests[0]?.accountUrl).toBeNull();
    expect(issuer.requests[1]?.accountKeyPem).toBe(issuer.requests[0]?.accountKeyPem);

    // The next pass finds the stored account, with its address.
    await db.kysely
      .updateTable('tls_certificates')
      .set({ next_attempt_at: new Date(0) })
      .execute();
    const again = fakeIssuer();
    await worker(again).runOnce();
    expect(again.newKeys).toBe(0);
    expect(again.requests[0]?.accountUrl).toBe('https://acme.test/acct/1');
  });

  it('keeps the account key encrypted', async () => {
    await setUp();
    await worker(fakeIssuer()).runOnce();
    const row = await db.kysely.selectFrom('acme_accounts').selectAll().executeTakeFirstOrThrow();
    expect(row.account_key_enc).not.toContain('fake-account-key');
    expect(row.account_key_enc).not.toContain('PRIVATE KEY');
  });

  it("uses a separate account for each Let's Encrypt", async () => {
    await setUp('staging');
    const issuer = fakeIssuer();
    await worker(issuer).runOnce();
    expect(issuer.requests[0]?.directoryUrl).toBe(
      'https://acme-staging-v02.api.letsencrypt.org/directory',
    );
    expect(
      await accounts.get('https://acme-staging-v02.api.letsencrypt.org/directory'),
    ).toBeDefined();
    expect(await accounts.get('https://acme-v02.api.letsencrypt.org/directory')).toBeUndefined();
  });

  it('records why one failed and backs off, while the others still get their certificate', async () => {
    await setUp();
    const issuer = fakeIssuer((request) => {
      if (request.fqdn === 'sip.platform.test') {
        throw new Error('DNS problem: NXDOMAIN looking up A for sip.platform.test');
      }
    });
    const now = new Date();

    const pass = await worker(issuer, { now: () => now }).runOnce();

    expect(pass.failed).toEqual(['sip.platform.test']);
    expect(pass.issued).toEqual(['console.platform.test']);
    const failed = await certs.find('sip.platform.test');
    expect(failed).toMatchObject({ status: 'failed', attempts: 1 });
    expect(failed?.lastError).toContain('NXDOMAIN');
    expect(failed?.nextAttemptAt.getTime()).toBe(now.getTime() + 60_000);
    expect((await certs.find('console.platform.test'))?.status).toBe('active');
  });

  it('does not try a failed one again until its time, then does, and succeeds', async () => {
    await setUp();
    let failing = true;
    const issuer = fakeIssuer((request) => {
      if (failing && request.fqdn === 'sip.platform.test') throw new Error('not yet');
    });
    let clock = new Date();
    const w = worker(issuer, { now: () => clock });
    await w.runOnce();

    clock = new Date(clock.getTime() + 30_000);
    expect((await w.runOnce()).issued).toEqual([]);

    failing = false;
    clock = new Date(clock.getTime() + 61_000);
    const later = await w.runOnce();
    expect(later.issued).toEqual(['sip.platform.test']);
    expect((await certs.find('sip.platform.test'))?.status).toBe('active');
  });

  it('renews a certificate inside its renewal window, and keeps the old one working if that fails', async () => {
    await setUp();
    await worker(fakeIssuer()).runOnce();
    const held = await certs.find('sip.platform.test');
    expect(held?.version).toBe(1);

    // Two months on, the 60-day certificates are inside the last month.
    const later = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);
    const failing = fakeIssuer(() => {
      throw new Error('CA unreachable');
    });
    const failedPass = await worker(failing, { now: () => later }).runOnce();
    expect([...failedPass.failed].sort()).toEqual(['console.platform.test', 'sip.platform.test']);
    expect((await certs.find('sip.platform.test'))?.status).toBe('active');
    expect(await certs.getMaterial('sip.platform.test')).toBeDefined();

    const retry = new Date(later.getTime() + 2 * 60_000);
    const renewedPass = await worker(fakeIssuer(), { now: () => retry }).runOnce();
    expect([...renewedPass.issued].sort()).toEqual(['console.platform.test', 'sip.platform.test']);
    expect((await certs.find('sip.platform.test'))?.version).toBe(2);
  });

  it('leaves a certificate not yet due alone', async () => {
    await setUp();
    await worker(fakeIssuer()).runOnce();
    const issuer = fakeIssuer();
    expect((await worker(issuer).runOnce()).issued).toEqual([]);
    expect(issuer.requests).toEqual([]);
  });
});
