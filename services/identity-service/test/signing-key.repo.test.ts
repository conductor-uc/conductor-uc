import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, jwtVerify } from 'jose';
import { createDatabase, migrateToLatest } from '@cuc/db';
import { databaseOrSkipReason, silentLogger, startTestDatabase } from '@cuc/testing';

import {
  createSigningKeyRepo,
  NoSigningKeyError,
  type SigningKeyRepo,
} from '../src/repo/signing-key.repo.js';
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

  const DAY = 24 * 60 * 60 * 1000;
  const MINUTE = 60 * 1000;
  /** The timer's settings: stage at 90 days, promote after 15 minutes published. */
  const timer = (now: Date) => ({ stage: 90, publishAheadMinutes: 15, now });

  async function liveKeys(): Promise<{ id: string; signing: boolean }[]> {
    const rows = await h.db.kysely
      .selectFrom('signing_keys')
      .select(['id', 'activated_at'])
      .where('retired_at', 'is', null)
      .execute();
    return rows.map((row) => ({ id: row.id, signing: row.activated_at !== null }));
  }

  async function keyCount(): Promise<number> {
    const rows = await h.db.kysely.selectFrom('signing_keys').select('id').execute();
    return rows.length;
  }

  async function jwksIds(repo: SigningKeyRepo): Promise<string[]> {
    return (await repo.forVerification(7)).map((key) => key.id).sort();
  }

  /** A fresh current key and no next key, whatever earlier tests left. */
  async function freshRepo(): Promise<{ repo: SigningKeyRepo; start: Date }> {
    const repo = createSigningKeyRepo(h.db, h.kek);
    await repo.rotate();
    return { repo, start: new Date() };
  }

  it('does nothing while the current key is younger than SIGNING_KEY_ROTATION_DAYS', async () => {
    const { repo, start } = await freshRepo();
    const before = await repo.current();

    expect(await repo.advance(timer(start))).toEqual({ action: 'none' });
    expect(await repo.advance(timer(new Date(start.getTime() + 89 * DAY)))).toEqual({
      action: 'none',
    });

    expect((await repo.current()).id).toBe(before.id);
    expect(await repo.next()).toBeUndefined();
  });

  it('stages a key that is published in the JWKS but does not sign', async () => {
    const { repo, start } = await freshRepo();
    const current = await repo.current();
    const jwksBefore = await jwksIds(repo);

    const step = await repo.advance(timer(new Date(start.getTime() + 90 * DAY)));

    expect(step.action).toBe('staged');
    const nextId = step.action === 'staged' ? step.next.id : '';
    expect((await repo.next())?.id).toBe(nextId);
    // Signing is unchanged; the JWKS has gained exactly the next key.
    expect((await repo.current()).id).toBe(current.id);
    expect(await jwksIds(repo)).toEqual([...jwksBefore, nextId].sort());
    expect(await liveKeys()).toEqual(
      expect.arrayContaining([
        { id: current.id, signing: true },
        { id: nextId, signing: false },
      ]),
    );
  });

  it('promotes the next key only once it has been published for the publish-ahead period', async () => {
    const { repo, start } = await freshRepo();
    const previous = await repo.current();
    const stagedAt = new Date(start.getTime() + 100 * DAY);
    const staged = await repo.advance(timer(stagedAt));
    const nextId = staged.action === 'staged' ? staged.next.id : '';

    // 14 minutes in: still waiting, still signing with the old key.
    const early = await repo.advance(timer(new Date(stagedAt.getTime() + 14 * MINUTE)));
    expect(early).toMatchObject({ action: 'waiting', next: { id: nextId } });
    expect((await repo.current()).id).toBe(previous.id);

    // 15 minutes in: promoted. The previous key is retired but still published.
    const due = await repo.advance(timer(new Date(stagedAt.getTime() + 15 * MINUTE)));
    expect(due).toMatchObject({
      action: 'promoted',
      previousKeyId: previous.id,
      currentKeyId: nextId,
    });
    expect((await repo.current()).id).toBe(nextId);
    expect(await repo.next()).toBeUndefined();
    expect(await jwksIds(repo)).toEqual(expect.arrayContaining([previous.id, nextId]));
    expect(await liveKeys()).toEqual([{ id: nextId, signing: true }]);

    // The new key's age counts from its promotion: nothing is due right after.
    expect(await repo.advance(timer(new Date(stagedAt.getTime() + 16 * MINUTE)))).toEqual({
      action: 'none',
    });
  });

  it('with automatic staging off, still promotes a key the operator staged', async () => {
    const { repo, start } = await freshRepo();
    const staged = await repo.advance({ stage: 'now', publishAheadMinutes: 15, now: start });
    expect(staged.action).toBe('staged');

    const later = new Date(start.getTime() + 400 * DAY);
    const step = await repo.advance({ stage: 'never', publishAheadMinutes: 15, now: later });

    expect(step.action).toBe('promoted');
    expect(await repo.advance({ stage: 'never', publishAheadMinutes: 15, now: later })).toEqual({
      action: 'none',
    });
  });

  it('several copies checking at once stage exactly once and promote exactly once', async () => {
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
    const copies = [
      createSigningKeyRepo(h.db, h.kek),
      createSigningKeyRepo(other, h.kek),
      createSigningKeyRepo(h.db, h.kek),
      createSigningKeyRepo(other, h.kek),
    ];
    try {
      const { start } = await freshRepo();
      for (let round = 1; round <= 3; round += 1) {
        const stageAt = new Date(start.getTime() + round * 100 * DAY);
        const keysBefore = await keyCount();

        const staging = await Promise.all(copies.map((repo) => repo.advance(timer(stageAt))));
        expect(staging.filter((step) => step.action === 'staged')).toHaveLength(1);
        expect(await keyCount()).toBe(keysBefore + 1);
        expect((await liveKeys()).filter((key) => !key.signing)).toHaveLength(1);

        const promoteAt = new Date(stageAt.getTime() + 20 * MINUTE);
        const promoting = await Promise.all(copies.map((repo) => repo.advance(timer(promoteAt))));
        expect(promoting.filter((step) => step.action === 'promoted')).toHaveLength(1);
        expect(await keyCount()).toBe(keysBefore + 1);
        const live = await liveKeys();
        expect(live).toHaveLength(1);
        expect(live[0]!.signing).toBe(true);
      }
    } finally {
      await other.destroy();
    }
  });

  it('rotateNow retires a staged next key too, and the new key signs at once', async () => {
    const { repo, start } = await freshRepo();
    const staged = await repo.advance({ stage: 'now', publishAheadMinutes: 15, now: start });
    const stagedId = staged.action === 'staged' ? staged.next.id : '';

    const result = await repo.rotateNow();

    expect((await repo.current()).id).toBe(result.current.id);
    expect(await repo.next()).toBeUndefined();
    expect(await liveKeys()).toEqual([{ id: result.current.id, signing: true }]);
    // Retired, not revoked: it stays published for the overlap like any retired key.
    expect(await jwksIds(repo)).toContain(stagedId);
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
    expect(await repo.advance({ stage: 'now', publishAheadMinutes: 0 })).toEqual({
      action: 'none',
    });

    await emptyDb.destroy();
    await handle.stop();
  });
});
