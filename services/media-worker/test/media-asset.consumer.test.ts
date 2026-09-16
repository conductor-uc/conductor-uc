import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventConsumer } from '@cuc/events';
import { natsOrSkipReason, databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';

import { createMediaAssetConsumer } from '../src/consumers/media-asset.consumer.js';
import { mediaWorkerEvents } from '../src/events.js';
import { resetSchema, startBusHarness, type BusHarness } from './harness.js';
import { ffmpegOrSkipReason } from './ffmpeg-availability.js';

const skipReason =
  (await databaseOrSkipReason()) ??
  (await natsOrSkipReason()) ??
  (await s3OrSkipReason()) ??
  (await ffmpegOrSkipReason());

const execFileAsync = promisify(execFile);
const PATHS = { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' };

/** See `pbx.consumer.test.ts`'s identical note (gap G-17, docs/decisions.md): a shared CI NATS server can deliver a stray, unrelated event into the same pull. */
async function runOnceUntilHandled(
  consumer: EventConsumer,
  attempts = 3,
): Promise<{ handled: number; failed: number }> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const pass = await consumer.runOnce();
    if (pass.handled > 0 || pass.failed > 0 || attempt === attempts) return pass;
  }
  throw new Error('unreachable');
}

function readWavFormat(buffer: Buffer): { sampleRate: number; channels: number } {
  return { channels: buffer.readUInt16LE(22), sampleRate: buffer.readUInt32LE(24) };
}

describe.skipIf(skipReason !== undefined)('media asset consumer', () => {
  let h: BusHarness;
  let toneMp3: Buffer;
  let workDir: string;

  beforeAll(async () => {
    h = await startBusHarness();
    workDir = await mkdtemp(path.join(tmpdir(), 'media-worker-consumer-test-'));
    const tonePath = path.join(workDir, 'tone.mp3');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-codec:a',
      'libmp3lame',
      tonePath,
    ]);
    toneMp3 = await readFile(tonePath);
  });

  afterAll(async () => {
    await h?.close();
    await rm(workDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await resetSchema(h.db);
    h.pbxConfig.assets = {};
    h.pbxConfig.completed = [];
    h.pbxConfig.failed = [];
    await h.bus.jsm.streams.purge('PBX');
  });

  function consumer() {
    return createMediaAssetConsumer(h.db, h.bus, h.logger, h.storage, h.pbxConfig, PATHS, {
      pullTimeoutMs: 5000,
    });
  }

  async function publish(tenantId: string, mediaAssetId: string): Promise<void> {
    const type = 'pbx.media_asset.finalize_requested' as const;
    const contract = mediaWorkerEvents.contract(type);
    mediaWorkerEvents.assertPayload(type, { mediaAssetId });
    await h.bus.publish({
      id: crypto.randomUUID(),
      type,
      schemaVersion: contract.schemaVersion,
      occurredAt: new Date().toISOString(),
      orgContext: { tenantId },
      data: { mediaAssetId },
    });
  }

  it('transcodes a real uploaded MP3 and reports completion with the transcoded variants actually in storage', async () => {
    const c = consumer();
    await c.ensure();

    const tenantId = crypto.randomUUID();
    const assetId = crypto.randomUUID();
    const objectKey = `media-assets/${assetId}/raw`;
    await h.storage.forTenant(tenantId).provisionBucket();
    await h.storage
      .forTenant(tenantId)
      .putObject(objectKey, toneMp3, { contentType: 'audio/mpeg' });
    h.pbxConfig.assets[assetId] = {
      id: assetId,
      kind: 'prompt',
      status: 'processing',
      contentType: 'audio/mpeg',
      objectKey,
    };

    await publish(tenantId, assetId);
    const pass = await runOnceUntilHandled(c);
    expect(pass.handled).toBeGreaterThanOrEqual(1);

    expect(h.pbxConfig.failed).toEqual([]);
    expect(h.pbxConfig.completed).toHaveLength(1);
    const [completion] = h.pbxConfig.completed;
    expect(completion).toMatchObject({ tenantId, id: assetId });
    expect(completion!.input.durationMs).toBeGreaterThanOrEqual(900);
    expect(completion!.input.durationMs).toBeLessThanOrEqual(1100);
    expect(completion!.input.variant8kKey).toBe(`media-assets/${assetId}/8k.wav`);
    expect(completion!.input.variant16kKey).toBe(`media-assets/${assetId}/16k.wav`);

    const wav8k = await h.storage.forTenant(tenantId).getObject(completion!.input.variant8kKey);
    const wav16k = await h.storage.forTenant(tenantId).getObject(completion!.input.variant16kKey);
    expect(readWavFormat(wav8k)).toEqual({ sampleRate: 8000, channels: 1 });
    expect(readWavFormat(wav16k)).toEqual({ sampleRate: 16000, channels: 1 });
  });

  it('reports failure, not an exception, when the upload is not real audio', async () => {
    const c = consumer();
    await c.ensure();

    const tenantId = crypto.randomUUID();
    const assetId = crypto.randomUUID();
    const objectKey = `media-assets/${assetId}/raw`;
    await h.storage.forTenant(tenantId).provisionBucket();
    await h.storage
      .forTenant(tenantId)
      .putObject(objectKey, Buffer.from('not audio at all'), { contentType: 'audio/mpeg' });
    h.pbxConfig.assets[assetId] = {
      id: assetId,
      kind: 'prompt',
      status: 'processing',
      contentType: 'audio/mpeg',
      objectKey,
    };

    await publish(tenantId, assetId);
    const pass = await runOnceUntilHandled(c);
    expect(pass.handled).toBeGreaterThanOrEqual(1);

    expect(h.pbxConfig.completed).toEqual([]);
    expect(h.pbxConfig.failed).toHaveLength(1);
    expect(h.pbxConfig.failed[0]).toMatchObject({ tenantId, id: assetId });
  });

  it('skips cleanly (neither completes nor fails) when the asset no longer exists', async () => {
    const c = consumer();
    await c.ensure();

    const tenantId = crypto.randomUUID();
    const assetId = crypto.randomUUID();
    // Deliberately never added to h.pbxConfig.assets — simulates the asset
    // having been deleted between `:finalize` and this event being handled.

    await publish(tenantId, assetId);
    const pass = await runOnceUntilHandled(c);
    expect(pass.handled).toBeGreaterThanOrEqual(1);

    expect(h.pbxConfig.completed).toEqual([]);
    expect(h.pbxConfig.failed).toEqual([]);
  });
});
