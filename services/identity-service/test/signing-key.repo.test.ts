import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, jwtVerify } from 'jose';
import { createDatabase, migrateToLatest } from '@cuc/db';
import { databaseOrSkipReason, silentLogger, startTestDatabase } from '@cuc/testing';

import { createSigningKeyRepo, NoSigningKeyError } from '../src/repo/signing-key.repo.js';
import { signAccessToken, verifyAccessToken } from '../src/tokens/access-token.js';
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

  /** Makes the current key look `days` old. */
  async function ageCurrentKey(days: number): Promise<void> {
    await h.db.kysely
      .updateTable('signing_keys')
      .set({ created_at: new Date(Date.now() - days * 24 * 60 * 60 * 1000) })
      .where('retired_at', 'is', null)
      .execute();
  }

  async function currentKeyIds(): Promise<string[]> {
    const rows = await h.db.kysely
      .selectFrom('signing_keys')
      .select('id')
      .where('retired_at', 'is', null)
      .execute();
    return rows.map((row) => row.id);
  }

  async function keyCount(): Promise<number> {
    const rows = await h.db.kysely.selectFrom('signing_keys').select('id').execute();
    return rows.length;
  }

  it('rotateIfOlderThan leaves a key younger than the threshold alone', async () => {
    const repo = createSigningKeyRepo(h.db, h.kek);
    await repo.rotate();
    const before = await repo.current();

    expect(await repo.rotateIfOlderThan(90)).toBeNull();
    await ageCurrentKey(89);
    expect(await repo.rotateIfOlderThan(90)).toBeNull();

    expect((await repo.current()).id).toBe(before.id);
  });

  it('rotateIfOlderThan rotates a key at or past the threshold', async () => {
    const repo = createSigningKeyRepo(h.db, h.kek);
    const before = await repo.current();
    await ageCurrentKey(90);

    const result = await repo.rotateIfOlderThan(90);

    expect(result).not.toBeNull();
    expect(result!.previousKeyId).toBe(before.id);
    expect(result!.revoked).toBe(0);
    expect(await currentKeyIds()).toEqual([result!.current.id]);
    // The replaced key keeps verifying through the overlap window.
    expect((await repo.forVerification(7)).map((key) => key.id)).toContain(before.id);
  });

  it('two copies of the service checking at once rotate exactly once', async () => {
    // A second connection pool, as a second copy of identity-service has.
    const other = createDatabase<IdentityServiceDb>({
      host: h.handle.host,
      port: h.handle.port,
      user: h.handle.user,
      password: h.handle.password,
      database: h.handle.database,
      poolSize: 4,
      logger: silentLogger(),
    });
    try {
      for (let round = 0; round < 3; round += 1) {
        await ageCurrentKey(120);
        const keysBefore = await keyCount();

        const results = await Promise.all([
          createSigningKeyRepo(h.db, h.kek).rotateIfOlderThan(90),
          createSigningKeyRepo(other, h.kek).rotateIfOlderThan(90),
          createSigningKeyRepo(h.db, h.kek).rotateIfOlderThan(90),
          createSigningKeyRepo(other, h.kek).rotateIfOlderThan(90),
        ]);

        expect(results.filter((result) => result !== null)).toHaveLength(1);
        expect(await keyCount()).toBe(keysBefore + 1);
        expect(await currentKeyIds()).toHaveLength(1);
      }
    } finally {
      await other.destroy();
    }
  });

  it('another copy signs with the new key from its next token after a rotation', async () => {
    const replicaA = createSigningKeyRepo(h.db, h.kek);
    const replicaB = createSigningKeyRepo(h.db, h.kek);
    const before = await replicaB.current();

    const rotated = await replicaA.rotate();

    expect((await replicaB.current()).id).toBe(rotated.id);
    expect(rotated.id).not.toBe(before.id);
  });

  it('rotateNow with revokePrevious leaves only the new key in the JWKS', async () => {
    const repo = createSigningKeyRepo(h.db, h.kek);
    await repo.rotate();
    await repo.rotate();
    const retiredBefore = await h.db.kysely
      .selectFrom('signing_keys')
      .select('id')
      .where('retired_at', 'is not', null)
      .where('revoked_at', 'is', null)
      .execute();
    expect((await repo.forVerification(7)).length).toBeGreaterThan(1);

    const result = await repo.rotateNow({ revokePrevious: true });

    // Every earlier key, the one just replaced included.
    expect(result.revoked).toBe(retiredBefore.length + 1);
    expect((await repo.forVerification(7)).map((key) => key.id)).toEqual([result.current.id]);
    expect((await repo.current()).id).toBe(result.current.id);
  });

  it('a revoked key no longer verifies a token it signed', async () => {
    const repo = createSigningKeyRepo(h.db, h.kek);
    const old = await repo.current();
    const token = await signAccessToken(
      old,
      { sub: 'user-1', org: 'org-1', ot: 'tenant', roles: [], perms: [], amr: ['pwd'], sid: 's' },
      600,
    );
    await expect(verifyAccessToken(token, await repo.forVerification(7))).resolves.toMatchObject({
      sub: 'user-1',
    });

    await repo.rotateNow({ revokePrevious: true });

    await expect(verifyAccessToken(token, await repo.forVerification(7))).rejects.toThrow(
      /No verification key/,
    );
  });

  it('a plain rotation keeps the previous key verifying (no revocation)', async () => {
    const repo = createSigningKeyRepo(h.db, h.kek);
    const old = await repo.current();
    const token = await signAccessToken(
      old,
      { sub: 'user-2', org: 'org-1', ot: 'tenant', roles: [], perms: [], amr: ['pwd'], sid: 's' },
      600,
    );

    const result = await repo.rotateNow();

    expect(result.revoked).toBe(0);
    await expect(verifyAccessToken(token, await repo.forVerification(7))).resolves.toMatchObject({
      sub: 'user-2',
    });
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
    // The automatic check never creates the first key; ensureCurrentKey does.
    expect(await repo.rotateIfOlderThan(0)).toBeNull();

    await emptyDb.destroy();
    await handle.stop();
  });
});
