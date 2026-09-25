import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FileKekProvider, keyVersionOf } from '@cuc/crypto';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import {
  databaseOrSkipReason,
  silentLogger,
  startTestDatabase,
  type TestDatabaseHandle,
} from '@cuc/testing';

import { parseRotateSigningKeyArgs } from '../src/cli/rotate-signing-key-args.js';
import { createKekRewrapJob, ENCRYPTED_COLUMNS } from '../src/kek-rewrap.js';
import type { RotationResult, SigningKey } from '../src/repo/signing-key.repo.js';
import { createSigningKeyRepo } from '../src/repo/signing-key.repo.js';
import type { IdentityServiceDb } from '../src/schema.js';
import { createSigningKeyRotator } from '../src/signing-key-rotation.js';
import { migrations } from './fixtures/migrations.js';

const skipReason = await databaseOrSkipReason();

describe('rotate-signing-key arguments', () => {
  it('defaults to a plain rotation', () => {
    expect(parseRotateSigningKeyArgs([])).toEqual({ revokePrevious: false, help: false });
  });

  it('accepts --revoke-previous', () => {
    expect(parseRotateSigningKeyArgs(['--revoke-previous'])).toEqual({
      revokePrevious: true,
      help: false,
    });
  });

  it('accepts --help', () => {
    expect(parseRotateSigningKeyArgs(['--help']).help).toBe(true);
  });

  it('refuses an unknown option rather than rotating without it', () => {
    expect(() => parseRotateSigningKeyArgs(['--revoke'])).toThrow();
    expect(() => parseRotateSigningKeyArgs(['--revoke-previous=false'])).toThrow();
  });

  it('refuses a stray argument', () => {
    expect(() => parseRotateSigningKeyArgs(['now'])).toThrow();
  });
});

describe('signing key rotator', () => {
  const rotation = (): RotationResult => ({
    previousKeyId: 'old',
    previousCreatedAt: new Date('2026-01-01T00:00:00Z'),
    current: { id: 'new' } as SigningKey,
    revoked: 0,
  });

  it('asks the repository to rotate past the configured age, at the injected time', async () => {
    const rotateIfOlderThan = vi.fn().mockResolvedValue(null);
    const now = new Date('2026-09-25T00:00:00Z');
    const rotator = createSigningKeyRotator({
      signingKeys: { rotateIfOlderThan },
      rotationDays: 90,
      logger: silentLogger(),
      now: () => now,
    });

    expect(await rotator.runOnce()).toBeNull();
    expect(rotateIfOlderThan).toHaveBeenCalledWith(90, now);
  });

  it('returns what a rotation did', async () => {
    const result = rotation();
    const rotator = createSigningKeyRotator({
      signingKeys: { rotateIfOlderThan: vi.fn().mockResolvedValue(result) },
      rotationDays: 90,
      logger: silentLogger(),
    });

    expect(await rotator.runOnce()).toBe(result);
  });

  it('shares one check between overlapping calls', async () => {
    let release!: (value: RotationResult | null) => void;
    const rotateIfOlderThan = vi.fn(
      () => new Promise<RotationResult | null>((resolve) => (release = resolve)),
    );
    const rotator = createSigningKeyRotator({
      signingKeys: { rotateIfOlderThan },
      rotationDays: 90,
      logger: silentLogger(),
    });

    const first = rotator.runOnce();
    const second = rotator.runOnce();
    release(null);

    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(rotateIfOlderThan).toHaveBeenCalledTimes(1);
  });

  it('runs the first check shortly after start, then on the interval, and stops', async () => {
    vi.useFakeTimers();
    try {
      const rotateIfOlderThan = vi.fn().mockResolvedValue(null);
      const rotator = createSigningKeyRotator({
        signingKeys: { rotateIfOlderThan },
        rotationDays: 90,
        logger: silentLogger(),
      });

      rotator.start(60_000, 1_000);
      await vi.advanceTimersByTimeAsync(999);
      expect(rotateIfOlderThan).toHaveBeenCalledTimes(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(rotateIfOlderThan).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(rotateIfOlderThan).toHaveBeenCalledTimes(2);

      await rotator.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(rotateIfOlderThan).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives a failed check', async () => {
    vi.useFakeTimers();
    try {
      const rotateIfOlderThan = vi
        .fn()
        .mockRejectedValueOnce(new Error('database down'))
        .mockResolvedValue(null);
      const rotator = createSigningKeyRotator({
        signingKeys: { rotateIfOlderThan },
        rotationDays: 90,
        logger: silentLogger(),
      });

      rotator.start(1_000, 0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(rotateIfOlderThan).toHaveBeenCalledTimes(2);
      await rotator.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.skipIf(skipReason !== undefined)('KEK re-wrap (identity-service)', () => {
  const KEY_1 = randomBytes(32);
  const KEY_2 = randomBytes(32);
  const before = new FileKekProvider({ keys: { '1': KEY_1 }, currentVersion: '1' });
  const during = new FileKekProvider({ keys: { '1': KEY_1, '2': KEY_2 }, currentVersion: '2' });
  const after = new FileKekProvider({ keys: { '2': KEY_2 }, currentVersion: '2' });

  let handle: TestDatabaseHandle;
  let db: Database<IdentityServiceDb>;

  beforeAll(async () => {
    handle = await startTestDatabase();
    db = createDatabase<IdentityServiceDb>({
      host: handle.host,
      port: handle.port,
      user: handle.user,
      password: handle.password,
      database: handle.database,
      logger: silentLogger(),
    });
    await migrateToLatest({ db: db.kysely, migrations, logger: silentLogger() });
  });

  afterAll(async () => {
    await db?.destroy();
    await handle?.stop();
  });

  it('covers the signing keys and TOTP secrets', () => {
    expect(ENCRYPTED_COLUMNS.map((c) => `${c.table}.${c.column}`)).toEqual([
      'signing_keys.private_key_enc',
      'mfa_factors.secret_enc',
    ]);
  });

  it('moves signing keys to the new version, and they still sign without the old one', async () => {
    const oldRepo = createSigningKeyRepo(db, before);
    await oldRepo.ensureCurrentKey();
    await oldRepo.rotate();
    const current = await oldRepo.current();

    const result = await createKekRewrapJob(db, during, silentLogger()).runOnce();

    expect(result).toEqual({ rewrapped: 2, skipped: 0, failed: 0, remaining: 0 });
    const rows = await db.kysely.selectFrom('signing_keys').select('private_key_enc').execute();
    expect(rows.map((row) => keyVersionOf(row.private_key_enc))).toEqual(['2', '2']);

    const reloaded = await createSigningKeyRepo(db, after).current();
    expect(reloaded.id).toBe(current.id);
  });
});
