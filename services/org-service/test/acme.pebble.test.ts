import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import { promisify } from 'node:util';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fileKekFromConfig } from '@cuc/crypto';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { databaseOrSkipReason, silentLogger, startTestDatabase } from '@cuc/testing';

import { createAcmeIssuer } from '../src/acme-issuer.js';
import { createCertificateWorker } from '../src/certificate-worker.js';
import { createAcmeAccountRepo } from '../src/repo/acme-account.repo.js';
import { createAcmeSettingsRepo } from '../src/repo/acme-settings.repo.js';
import { createCertificateRepo, type CertificateRepo } from '../src/repo/certificate.repo.js';
import type { OrgServiceDb } from '../src/schema.js';
import { migrations } from '../migrations/index.js';

const execFileAsync = promisify(execFile);

/**
 * The real ACME client against Pebble, Let's Encrypt's own test CA, and its mock
 * DNS server (`pebble-challtestsrv`), both in Docker on the host network. This
 * test answers the CA's HTTP-01 request itself, from the same table the gateway
 * reads, so what is exercised is everything except the gateway hop: the client,
 * the account, the challenge, the CSR, the certificate, and its storage.
 *
 * Skipped without Docker. Needs ports 14000, 15000, 8053, 8055 and 5002 free on
 * the host.
 */
async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['info'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const dbSkip = await databaseOrSkipReason();
const skipReason =
  dbSkip ?? ((await dockerAvailable()) ? undefined : 'Docker is not available for Pebble');

const DIRECTORY = 'https://127.0.0.1:14000/dir';
const PEBBLE = 'ghcr.io/letsencrypt/pebble:latest';
const CHALLTESTSRV = 'ghcr.io/letsencrypt/pebble-challtestsrv:latest';
const NAMES = ['pebble-test-dns', 'pebble-test-ca'];

const docker = (...args: string[]) => execFileAsync('docker', args, { timeout: 180_000 });

describe.skipIf(skipReason !== undefined)('certificates from an ACME server (Pebble)', () => {
  let db: Database<OrgServiceDb>;
  let certs: CertificateRepo;
  let stop: () => Promise<void>;
  let responder: HttpServer;
  let refuse: Set<string>;
  let previousTlsSetting: string | undefined;

  const settings = () => createAcmeSettingsRepo(db, { directoryUrlOverride: DIRECTORY });
  let accounts: ReturnType<typeof createAcmeAccountRepo>;

  beforeAll(async () => {
    // Pebble's own certificate is not one any store trusts.
    previousTlsSetting = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

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

    // What the gateway does on port 80: answer from the challenge table.
    refuse = new Set();
    responder = createServer((request, response) => {
      const host = (request.headers.host ?? '').replace(/:\d+$/, '');
      const token = /^\/\.well-known\/acme-challenge\/([\w-]+)$/.exec(request.url ?? '')?.[1];
      void (async () => {
        const answer =
          token === undefined || refuse.has(host) ? undefined : await certs.getChallenge(token);
        response.writeHead(answer === undefined ? 404 : 200, { 'content-type': 'text/plain' });
        response.end(answer ?? 'not found');
      })();
    });
    await new Promise<void>((resolve) => responder.listen(5002, '127.0.0.1', resolve));

    await docker('rm', '-f', ...NAMES).catch(() => undefined);
    await docker(
      'run',
      '-d',
      '--rm',
      '--network',
      'host',
      '--name',
      NAMES[0] ?? '',
      CHALLTESTSRV,
      '-http01',
      '',
      '-https01',
      '',
      '-tlsalpn01',
      '',
      '-doh',
      '',
      '-defaultIPv6',
      '',
      '-http01',
      '',
      '-https01',
      '',
      '-tlsalpn01',
      '',
      '-doh',
      '',
    );
    await docker(
      'run',
      '-d',
      '--rm',
      '--network',
      'host',
      '--name',
      NAMES[1] ?? '',
      '-e',
      'PEBBLE_VA_NOSLEEP=1',
      PEBBLE,
      '-dnsserver',
      '127.0.0.1:8053',
    );
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        if ((await fetch(DIRECTORY)).ok) break;
      } catch {
        // Still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    stop = async () => {
      responder.close();
      await docker('rm', '-f', ...NAMES).catch(() => undefined);
      await db.destroy();
      await handle.stop();
      if (previousTlsSetting === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = previousTlsSetting;
    };
  }, 240_000);

  afterAll(async () => {
    await stop?.();
  });

  beforeEach(async () => {
    refuse.clear();
    await db.kysely.deleteFrom('acme_challenges').execute();
    await db.kysely.deleteFrom('acme_accounts').execute();
    await db.kysely.deleteFrom('acme_settings').execute();
    await db.kysely.deleteFrom('tls_certificates').execute();
    await db.kysely.deleteFrom('outbox').execute();
    await certs.reconcileWanted();
    await settings().save({
      contactEmail: 'certs@example.test',
      directory: 'production',
      agreeToTerms: true,
      termsUrl: 'https://example.test/terms',
      actorId: 'user-1',
    });
  });

  const worker = () =>
    createCertificateWorker({
      certs,
      settings: settings(),
      accounts,
      issuer: createAcmeIssuer(),
      logger: silentLogger(),
    });

  it('obtains a certificate for each wanted name, and keeps it with its key', async () => {
    const pass = await worker().runOnce();

    expect(
      pass.failed,
      `why: ${String((await certs.find('sip.platform.test'))?.lastError)}`,
    ).toEqual([]);
    expect([...pass.issued].sort()).toEqual(['console.platform.test', 'sip.platform.test']);
    for (const fqdn of ['sip.platform.test', 'console.platform.test']) {
      const material = await certs.getMaterial(fqdn);
      expect(material?.certificatePem).toContain('BEGIN CERTIFICATE');
      // The leaf and at least Pebble's intermediate.
      expect(
        (material?.certificatePem.match(/BEGIN CERTIFICATE/g) ?? []).length,
      ).toBeGreaterThanOrEqual(2);
      expect(material?.privateKeyPem).toContain('PRIVATE KEY');
      expect(material?.notAfter.getTime()).toBeGreaterThan(Date.now());
      expect((await certs.find(fqdn))?.status).toBe('active');
    }
    // Answers are removed once the CA has looked.
    expect(await db.kysely.selectFrom('acme_challenges').selectAll().execute()).toEqual([]);
    const events = await db.kysely
      .selectFrom('outbox')
      .select('type')
      .where('type', '=', 'org.certificate.issued')
      .execute();
    expect(events).toHaveLength(2);
  }, 120_000);

  it('registers one account, keeps its address, and reuses it on the next pass', async () => {
    await worker().runOnce();
    const account = await accounts.get(DIRECTORY);
    expect(account?.accountUrl).toMatch(/^https:\/\/127\.0\.0\.1:14000\/my-account\//);

    await db.kysely
      .updateTable('tls_certificates')
      .set({ next_attempt_at: new Date(0) })
      .execute();
    const again = await worker().runOnce();
    expect(again.failed).toEqual([]);
    expect((await accounts.get(DIRECTORY))?.accountUrl).toBe(account?.accountUrl);
    expect((await certs.find('sip.platform.test'))?.version).toBe(2);
  }, 180_000);

  it("records the CA's own reason when it cannot validate a name, without stopping the rest", async () => {
    refuse.add('sip.platform.test');

    const pass = await worker().runOnce();

    expect(pass.issued).toEqual(['console.platform.test']);
    expect(pass.failed).toEqual(['sip.platform.test']);
    const failed = await certs.find('sip.platform.test');
    expect(failed).toMatchObject({ status: 'failed', attempts: 1 });
    expect(failed?.lastError).toMatch(/404|invalid response|unauthorized/i);
    expect(await certs.getMaterial('sip.platform.test')).toBeUndefined();
    expect((await certs.find('console.platform.test'))?.status).toBe('active');
  }, 180_000);
});
