import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { databaseOrSkipReason, silentLogger, startTestDatabase } from '@cuc/testing';

import { InvalidContactEmailError } from '../src/domain/acme.js';
import { createAcmeSettingsRepo, type AcmeSettingsRepo } from '../src/repo/acme-settings.repo.js';
import type { OrgServiceDb } from '../src/schema.js';
import { migrations } from '../migrations/index.js';

const skipReason = await databaseOrSkipReason();
const TERMS = 'https://letsencrypt.org/documents/LE-SA-v9.9.pdf';

describe.skipIf(skipReason !== undefined)('acme settings repo', () => {
  let db: Database<OrgServiceDb>;
  let repo: AcmeSettingsRepo;
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
    repo = createAcmeSettingsRepo(db);
    stop = async () => {
      await db.destroy();
      await handle.stop();
    };
  });

  afterAll(async () => {
    await stop?.();
  });

  beforeEach(async () => {
    await db.kysely.deleteFrom('acme_settings').execute();
  });

  it('starts empty: production chosen, no address, terms not agreed, not ready', async () => {
    expect(await repo.get()).toMatchObject({
      contactEmail: null,
      directory: 'production',
      directoryUrl: 'https://acme-v02.api.letsencrypt.org/directory',
      termsAgreed: false,
      termsAgreedAt: null,
      termsAgreedBy: null,
      ready: false,
    });
  });

  it('is ready only with an address and the terms agreed, and records who agreed and when', async () => {
    const now = new Date('2026-09-24T12:00:00Z');
    const onlyAddress = await repo.save({
      contactEmail: ' Certs@Example.com ',
      directory: 'production',
      agreeToTerms: false,
      termsUrl: TERMS,
      actorId: 'user-1',
      now,
    });
    expect(onlyAddress).toMatchObject({ contactEmail: 'certs@example.com', ready: false });

    const agreed = await repo.save({
      contactEmail: 'certs@example.com',
      directory: 'production',
      agreeToTerms: true,
      termsUrl: TERMS,
      actorId: 'user-1',
      now,
    });
    expect(agreed).toMatchObject({
      ready: true,
      termsAgreed: true,
      termsAgreedBy: 'user-1',
      termsUrl: TERMS,
    });
    expect(agreed.termsAgreedAt).toEqual(now);
    expect(await repo.get()).toMatchObject({ ready: true, termsAgreedBy: 'user-1' });
  });

  it('is not ready with terms agreed and no address', async () => {
    const saved = await repo.save({
      contactEmail: null,
      directory: 'production',
      agreeToTerms: true,
      termsUrl: TERMS,
      actorId: 'user-1',
    });
    expect(saved).toMatchObject({ termsAgreed: true, ready: false });
  });

  it('keeps the original who and when when the same agreement is saved again', async () => {
    const first = new Date('2026-09-24T12:00:00Z');
    await repo.save({
      contactEmail: 'a@example.com',
      directory: 'production',
      agreeToTerms: true,
      termsUrl: TERMS,
      actorId: 'user-1',
      now: first,
    });
    const again = await repo.save({
      contactEmail: 'b@example.com',
      directory: 'production',
      agreeToTerms: true,
      termsUrl: 'https://letsencrypt.org/documents/LE-SA-v10.pdf',
      actorId: 'user-2',
      now: new Date('2026-10-01T12:00:00Z'),
    });
    expect(again).toMatchObject({
      contactEmail: 'b@example.com',
      termsAgreedBy: 'user-1',
      termsUrl: TERMS,
    });
    expect(again.termsAgreedAt).toEqual(first);
  });

  it('makes the agreement belong to one directory: switching without agreeing again un-agrees', async () => {
    await repo.save({
      contactEmail: 'a@example.com',
      directory: 'production',
      agreeToTerms: true,
      termsUrl: TERMS,
      actorId: 'user-1',
    });

    const staging = await repo.save({
      contactEmail: 'a@example.com',
      directory: 'staging',
      agreeToTerms: false,
      termsUrl: TERMS,
      actorId: 'user-1',
    });
    expect(staging).toMatchObject({
      directory: 'staging',
      directoryUrl: 'https://acme-staging-v02.api.letsencrypt.org/directory',
      termsAgreed: false,
      ready: false,
    });

    const agreedForStaging = await repo.save({
      contactEmail: 'a@example.com',
      directory: 'staging',
      agreeToTerms: true,
      termsUrl: TERMS,
      actorId: 'user-2',
    });
    expect(agreedForStaging).toMatchObject({ ready: true, termsAgreedBy: 'user-2' });
  });

  it('lets the agreement be withdrawn', async () => {
    await repo.save({
      contactEmail: 'a@example.com',
      directory: 'production',
      agreeToTerms: true,
      termsUrl: TERMS,
      actorId: 'user-1',
    });
    const withdrawn = await repo.save({
      contactEmail: 'a@example.com',
      directory: 'production',
      agreeToTerms: false,
      termsUrl: null,
      actorId: 'user-1',
    });
    expect(withdrawn).toMatchObject({
      termsAgreed: false,
      termsAgreedAt: null,
      termsAgreedBy: null,
      ready: false,
    });
  });

  it('refuses a bad address without changing anything', async () => {
    await repo.save({
      contactEmail: 'a@example.com',
      directory: 'production',
      agreeToTerms: true,
      termsUrl: TERMS,
      actorId: 'user-1',
    });
    await expect(
      repo.save({
        contactEmail: 'not an email',
        directory: 'production',
        agreeToTerms: true,
        termsUrl: TERMS,
        actorId: 'user-1',
      }),
    ).rejects.toBeInstanceOf(InvalidContactEmailError);
    expect((await repo.get()).contactEmail).toBe('a@example.com');
  });

  it('can be pointed at another ACME server for a deployment or a test, whichever directory is chosen', async () => {
    const own = createAcmeSettingsRepo(db, {
      directoryUrlOverride: 'https://pebble.test:14000/dir',
    });
    expect((await own.get()).directoryUrl).toBe('https://pebble.test:14000/dir');
  });
});
