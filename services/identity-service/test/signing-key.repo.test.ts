import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, jwtVerify } from 'jose';
import { createDatabase, migrateToLatest } from '@cuc/db';
import { databaseOrSkipReason, silentLogger, startTestDatabase } from '@cuc/testing';

import { createSigningKeyRepo, NoSigningKeyError } from '../src/repo/signing-key.repo.js';
import type { IdentityServiceDb } from '../src/schema.js';
import { migrations } from './fixtures/migrations.js';
import { startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();

describe.skipIf(skipReason !== undefined)('signing key repo', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  it('ensureCurrentKey is idempotent: a second call returns the same key', async () => {
    const repo = createSigningKeyRepo(h.db, h.kek);

    const first = await repo.ensureCurrentKey();
    const second = await repo.ensureCurrentKey();

    expect(second.id).toBe(first.id);
  });

  it('rotate() retires the old key and makes a new one current', async () => {
    const repo = createSigningKeyRepo(h.db, h.kek);
    const before = await repo.current();

    const after = await repo.rotate();

    expect(after.id).not.toBe(before.id);
    expect((await repo.current()).id).toBe(after.id);
  });

  it('a retired key still verifies within the overlap window', async () => {
    const repo = createSigningKeyRepo(h.db, h.kek);
    const before = await repo.current();

    await repo.rotate();

    const verifiable = await repo.forVerification(7);
    expect(verifiable.map((key) => key.id)).toContain(before.id);
  });

  it('a key retired before the overlap window drops out of verification', async () => {
    const repo = createSigningKeyRepo(h.db, h.kek);
    const before = await repo.current();

    await repo.rotate();

    // Zero-day overlap: nothing retired is still valid, only the current key.
    const verifiable = await repo.forVerification(0);
    expect(verifiable.map((key) => key.id)).not.toContain(before.id);
  });

  it('the private key round-trips through encryption correctly after reload', async () => {
    const repo = createSigningKeyRepo(h.db, h.kek);
    const key = await repo.current();

    const jwt = await new SignJWT({ x: 1 })
      .setProtectedHeader({ alg: 'EdDSA', kid: key.id })
      .setSubject('probe')
      .sign(key.privateKey);

    const { payload } = await jwtVerify(jwt, key.publicKey, { algorithms: ['EdDSA'] });
    expect(payload.sub).toBe('probe');
  });

  it('current() throws a clear error rather than signing with nothing', async () => {
    const logger = silentLogger();
    const handle = await startTestDatabase();
    const emptyDb = createDatabase<IdentityServiceDb>({
      host: handle.host,
      port: handle.port,
      user: handle.user,
      password: handle.password,
      database: handle.database,
      logger,
    });
    await migrateToLatest({ db: emptyDb.kysely, migrations, logger });

    const repo = createSigningKeyRepo(emptyDb, h.kek);
    await expect(repo.current()).rejects.toThrow(NoSigningKeyError);

    await emptyDb.destroy();
    await handle.stop();
  });
});
