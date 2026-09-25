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

import {
  parseRotateSigningKeyArgs,
  runRotateSigningKey,
} from '../src/cli/rotate-signing-key-command.js';
import { createKekRewrapJob, ENCRYPTED_COLUMNS } from '../src/kek-rewrap.js';
import type { RotationStep } from '../src/repo/signing-key.repo.js';
import { createSigningKeyRepo } from '../src/repo/signing-key.repo.js';
import type { IdentityServiceDb } from '../src/schema.js';
import { createSigningKeyRotator } from '../src/signing-key-rotation.js';
import { migrations } from './fixtures/migrations.js';

const skipReason = await databaseOrSkipReason();

describe('rotate-signing-key arguments', () => {
  it('defaults to a publish-ahead rotation', () => {
    expect(parseRotateSigningKeyArgs([])).toEqual({
      now: false,
      revokePrevious: false,
      help: false,
    });
  });

  it('accepts --now', () => {
    expect(parseRotateSigningKeyArgs(['--now'])).toEqual({
      now: true,
      revokePrevious: false,
      help: false,
    });
  });

  it('--revoke-previous implies --now', () => {
    expect(parseRotateSigningKeyArgs(['--revoke-previous'])).toEqual({
      now: true,
      revokePrevious: true,
      help: false,
    });
    expect(parseRotateSigningKeyArgs(['--revoke-previous', '--now'])).toMatchObject({
      now: true,
      revokePrevious: true,
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
  const NONE: RotationStep = { action: 'none' };

  it('asks the repository to stage past the configured age and promote after publish-ahead', async () => {
    const advance = vi.fn().mockResolvedValue(NONE);
    const now = new Date('2026-09-25T00:00:00Z');
    const rotator = createSigningKeyRotator({
      signingKeys: { advance },
      rotationDays: 90,
      publishAheadMinutes: 15,
      logger: silentLogger(),
      now: () => now,
    });

    expect(await rotator.runOnce()).toBe(NONE);
    expect(advance).toHaveBeenCalledWith({ stage: 90, publishAheadMinutes: 15, now });
  });

  it('with SIGNING_KEY_ROTATION_DAYS at 0, never stages but still promotes', async () => {
    const advance = vi.fn().mockResolvedValue(NONE);
    const rotator = createSigningKeyRotator({
      signingKeys: { advance },
      rotationDays: 0,
      publishAheadMinutes: 15,
      logger: silentLogger(),
    });

    await rotator.runOnce();
    expect(advance).toHaveBeenCalledWith(expect.objectContaining({ stage: 'never' }));
  });

  it('returns what the step did', async () => {
    const step: RotationStep = {
      action: 'promoted',
      previousKeyId: 'old',
      previousCreatedAt: new Date('2026-01-01T00:00:00Z'),
      currentKeyId: 'new',
    };
    const rotator = createSigningKeyRotator({
      signingKeys: { advance: vi.fn().mockResolvedValue(step) },
      rotationDays: 90,
      publishAheadMinutes: 15,
      logger: silentLogger(),
    });

    expect(await rotator.runOnce()).toBe(step);
  });

  it('shares one check between overlapping calls', async () => {
    let release!: (value: RotationStep) => void;
    const advance = vi.fn(() => new Promise<RotationStep>((resolve) => (release = resolve)));
    const rotator = createSigningKeyRotator({
      signingKeys: { advance },
      rotationDays: 90,
      publishAheadMinutes: 15,
      logger: silentLogger(),
    });

    const first = rotator.runOnce();
    const second = rotator.runOnce();
    release(NONE);

    expect(await first).toBe(NONE);
    expect(await second).toBe(NONE);
    expect(advance).toHaveBeenCalledTimes(1);
  });

  it('runs the first check shortly after start, then on the interval, and stops', async () => {
    vi.useFakeTimers();
    try {
      const advance = vi.fn().mockResolvedValue(NONE);
      const rotator = createSigningKeyRotator({
        signingKeys: { advance },
        rotationDays: 90,
        publishAheadMinutes: 15,
        logger: silentLogger(),
      });

      rotator.start(60_000, 1_000);
      await vi.advanceTimersByTimeAsync(999);
      expect(advance).toHaveBeenCalledTimes(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(advance).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(advance).toHaveBeenCalledTimes(2);

      await rotator.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(advance).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives a failed check', async () => {
    vi.useFakeTimers();
    try {
      const advance = vi
        .fn()
        .mockRejectedValueOnce(new Error('database down'))
        .mockResolvedValue(NONE);
      const rotator = createSigningKeyRotator({
        signingKeys: { advance },
        rotationDays: 90,
        publishAheadMinutes: 15,
        logger: silentLogger(),
      });

      rotator.start(1_000, 0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(advance).toHaveBeenCalledTimes(2);
      await rotator.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.skipIf(skipReason !== undefined)('rotate-signing-key command', () => {
  const kek = new FileKekProvider({ keys: { '1': randomBytes(32) }, currentVersion: '1' });
  const settings = { publishAheadMinutes: 15, overlapDays: 7 };
  const MINUTE = 60 * 1000;

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
    await createSigningKeyRepo(db, kek).ensureCurrentKey();
  });

  afterAll(async () => {
    await db?.destroy();
    await handle?.stop();
  });

  const ids = async () =>
    (await createSigningKeyRepo(db, kek).forVerification(7)).map((key) => key.id).sort();

  it('by default stages a published next key, says when it signs, and a later run promotes it', async () => {
    const repo = createSigningKeyRepo(db, kek);
    const before = await repo.current();
    const start = new Date();
    const args = parseRotateSigningKeyArgs([]);

    const staged = await runRotateSigningKey(repo, args, settings, start);
    expect(staged.message).toMatch(/published; it starts signing after/);
    const nextId = staged.fields['nextKeyId'] as string;
    expect(staged.fields['promotesAfter']).toBe(
      new Date(start.getTime() + 15 * MINUTE).toISOString(),
    );
    expect((await repo.current()).id).toBe(before.id);
    expect(await ids()).toContain(nextId);

    const early = await runRotateSigningKey(
      repo,
      args,
      settings,
      new Date(start.getTime() + MINUTE),
    );
    expect(early.message).toMatch(/not due yet/);
    expect((await repo.current()).id).toBe(before.id);

    const due = await runRotateSigningKey(
      repo,
      args,
      settings,
      new Date(start.getTime() + 16 * MINUTE),
    );
    expect(due.message).toMatch(/promoted/);
    expect((await repo.current()).id).toBe(nextId);
    expect(await ids()).toEqual(expect.arrayContaining([before.id, nextId]));
  });

  it('--now switches at once and keeps the previous key published', async () => {
    const repo = createSigningKeyRepo(db, kek);
    const before = await repo.current();

    const outcome = await runRotateSigningKey(repo, parseRotateSigningKeyArgs(['--now']), settings);

    expect(outcome.message).toMatch(/rotated now/);
    expect((await repo.current()).id).toBe(outcome.fields['keyId']);
    expect(await ids()).toContain(before.id);
  });

  it('--revoke-previous switches at once, even with a key published ahead, and leaves only the new key', async () => {
    const repo = createSigningKeyRepo(db, kek);
    await runRotateSigningKey(repo, parseRotateSigningKeyArgs([]), settings);
    expect((await ids()).length).toBeGreaterThan(2);

    const outcome = await runRotateSigningKey(
      repo,
      parseRotateSigningKeyArgs(['--revoke-previous']),
      settings,
    );

    expect(outcome.message).toMatch(/revoked/);
    expect((await repo.current()).id).toBe(outcome.fields['keyId']);
    expect(await ids()).toEqual([outcome.fields['keyId']]);
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
