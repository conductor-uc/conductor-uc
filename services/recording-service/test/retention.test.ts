import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';
import { GetBucketLifecycleConfigurationCommand, S3Client } from '@aws-sdk/client-s3';

import { applyLifecycleBackstop, createRetentionJob } from '../src/retention.js';
import { buildWav } from '../src/uploader/wav.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());
const AUDIO = buildWav({ sampleRate: 8000, channels: 1, seconds: 1 });
const DAY = 86_400_000;

describe.skipIf(skipReason !== undefined)('retention job (S5-05)', () => {
  let h: Harness;
  /** The fake clock. Tests move it; nothing waits. */
  let clock = new Date('2026-06-01T00:00:00.000Z');

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(async () => {
    await resetSchema(h.db);
    clock = new Date('2026-06-01T00:00:00.000Z');
  });

  const job = (overrides: { batchSize?: number; pendingMaxAgeHours?: number } = {}) =>
    createRetentionJob({
      recordings: h.recordings,
      storage: h.storage,
      logger: h.logger,
      now: () => clock,
      batchSize: overrides.batchSize ?? 100,
      pendingMaxAgeHours: overrides.pendingMaxAgeHours ?? 72,
    });

  /** A ready recording with audio in the bucket, retention taken from `days`. */
  async function seed(tenantId: string, days: number) {
    const recording = await h.recordings.register(
      { tenantId },
      { callUuid: crypto.randomUUID(), direction: 'inbound', announced: false },
    );
    await h.storage.forTenant(tenantId).provisionBucket();
    await h.storage.forTenant(tenantId).putObject(recording.objectKey, AUDIO);
    return h.recordings.complete({ tenantId }, recording.id, {
      sizeBytes: AUDIO.length,
      durationMs: 1000,
      sha256: null,
      retentionDays: days,
    });
  }

  const exists = async (tenantId: string, key: string) =>
    (await h.storage.forTenant(tenantId).headObject(key)) !== undefined;

  it('deletes nothing before the retention date, and everything past it', async () => {
    const tenantId = crypto.randomUUID();
    const recording = await seed(tenantId, 30);
    const sweep = job();

    clock = new Date(recording.startedAt.getTime() + 29 * DAY);
    expect(await sweep.runOnce()).toMatchObject({ expired: 0 });
    expect(await exists(tenantId, recording.objectKey)).toBe(true);
    expect((await h.recordings.findById({ tenantId }, recording.id))?.status).toBe('ready');

    clock = new Date(recording.startedAt.getTime() + 30 * DAY + 1000);
    expect(await sweep.runOnce()).toMatchObject({ expired: 1, deleteFailures: 0 });
    expect(await exists(tenantId, recording.objectKey)).toBe(false);
    // The row stays, marked expired, so a CDR link still resolves.
    expect(await h.recordings.findById({ tenantId }, recording.id)).toMatchObject({
      status: 'expired',
    });

    const events = await h.db.kysely.selectFrom('outbox').select('type').execute();
    expect(events.map((e) => e.type)).toContain('recording.recording.expired');

    // Running again finds nothing more to do.
    expect(await sweep.runOnce()).toMatchObject({ expired: 0 });
  });

  it('honours each tenant’s own period, and never keeps or deletes across tenants', async () => {
    const short = crypto.randomUUID();
    const long = crypto.randomUUID();
    const a = await seed(short, 7);
    const b = await seed(long, 365);
    const forever = await seed(long, 0);

    clock = new Date(a.startedAt.getTime() + 8 * DAY);
    expect(await job().runOnce()).toMatchObject({ expired: 1 });
    expect(await exists(short, a.objectKey)).toBe(false);
    expect(await exists(long, b.objectKey)).toBe(true);
    expect(await exists(long, forever.objectKey)).toBe(true);

    clock = new Date(a.startedAt.getTime() + 400 * DAY);
    await job().runOnce();
    expect((await h.recordings.findById({ tenantId: long }, b.id))?.status).toBe('expired');
    expect((await h.recordings.findById({ tenantId: long }, forever.id))?.status).toBe('ready'); // 0 = keep
    expect(await exists(long, forever.objectKey)).toBe(true);
  });

  it('shortening retention makes already-made recordings expire on the new schedule', async () => {
    const tenantId = crypto.randomUUID();
    const recording = await seed(tenantId, 365);
    await h.settings.setRetentionDays({ tenantId }, 10);

    clock = new Date(recording.startedAt.getTime() + 11 * DAY);
    expect(await job().runOnce()).toMatchObject({ expired: 1 });
  });

  it('works through a backlog in batches', async () => {
    const tenantId = crypto.randomUUID();
    const seeded = [await seed(tenantId, 1), await seed(tenantId, 1), await seed(tenantId, 1)];
    clock = new Date(seeded[0]!.startedAt.getTime() + 2 * DAY);

    const sweep = job({ batchSize: 2 });
    expect((await sweep.runOnce()).expired).toBe(2);
    expect((await sweep.runOnce()).expired).toBe(1);
    expect((await sweep.runOnce()).expired).toBe(0);
  });

  it('leaves the row ready and retries next pass when the audio cannot be deleted', async () => {
    const tenantId = crypto.randomUUID();
    const recording = await seed(tenantId, 1);
    clock = new Date(recording.startedAt.getTime() + 2 * DAY);

    const failing = createRetentionJob({
      recordings: h.recordings,
      logger: h.logger,
      now: () => clock,
      batchSize: 10,
      pendingMaxAgeHours: 72,
      storage: {
        forTenant: () => ({
          deleteObject: () => Promise.reject(new Error('storage down')),
        }),
        forPlatform: () => {
          throw new Error('unused');
        },
      } as never,
    });
    expect(await failing.runOnce()).toMatchObject({ expired: 0, deleteFailures: 1 });
    expect((await h.recordings.findById({ tenantId }, recording.id))?.status).toBe('ready');

    expect(await job().runOnce()).toMatchObject({ expired: 1 });
    expect(await exists(tenantId, recording.objectKey)).toBe(false);
  });

  it('marks recordings that were registered but never uploaded as failed after the cutoff', async () => {
    const tenantId = crypto.randomUUID();
    const stale = await h.recordings.register(
      { tenantId },
      { callUuid: 'c', direction: 'inbound', announced: false },
    );
    clock = new Date(stale.startedAt.getTime() + 71 * 3_600_000);
    expect((await job().runOnce()).stalePending).toBe(0);
    expect((await h.recordings.findById({ tenantId }, stale.id))?.status).toBe('pending');

    clock = new Date(stale.startedAt.getTime() + 73 * 3_600_000);
    expect((await job().runOnce()).stalePending).toBe(1);
    expect(await h.recordings.findById({ tenantId }, stale.id)).toMatchObject({
      status: 'failed',
      failureReason: 'never_uploaded',
    });
  });

  describe('S3 lifecycle backstop', () => {
    async function rules(tenantId: string) {
      const location = h.storage.forTenant(tenantId).locate('recordings/');
      const handle = await (await import('@cuc/testing')).startTestS3();
      const client = new S3Client({
        region: handle.region,
        endpoint: handle.endpoint,
        forcePathStyle: handle.forcePathStyle,
        credentials: { accessKeyId: handle.accessKeyId, secretAccessKey: handle.secretAccessKey },
      });
      try {
        return (
          (
            await client.send(
              new GetBucketLifecycleConfigurationCommand({ Bucket: location.bucket }),
            )
          ).Rules ?? []
        );
      } catch (error) {
        if ((error as { name?: string }).name === 'NoSuchLifecycleConfiguration') return [];
        throw error;
      }
    }

    it('sets an expiry a day after the retention period, replaces it, and removes it when retention is off', async () => {
      const tenantId = crypto.randomUUID();

      await applyLifecycleBackstop(h.storage, h.logger, tenantId, 30);
      let current = await rules(tenantId);
      expect(current).toHaveLength(1);
      expect(current[0]?.Expiration?.Days).toBe(31);
      expect(current[0]?.Filter?.Prefix).toBe('recordings/');

      await applyLifecycleBackstop(h.storage, h.logger, tenantId, 7);
      current = await rules(tenantId);
      expect(current).toHaveLength(1);
      expect(current[0]?.Expiration?.Days).toBe(8);

      await applyLifecycleBackstop(h.storage, h.logger, tenantId, 0);
      expect(await rules(tenantId)).toEqual([]);
    });
  });
});
