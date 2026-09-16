import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { crossTenantProbe, databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';

import { InvalidMediaAssetError } from '../src/domain/media-asset.js';
import {
  InvalidMediaAssetStatusError,
  MediaAssetNotFoundError,
} from '../src/repo/media-asset.repo.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());

describe.skipIf(skipReason !== undefined)('media asset repo', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
  });

  function ctxFor(tenantId: string) {
    return { tenantId };
  }

  const VALID_INPUT = { kind: 'prompt', label: 'Welcome greeting', contentType: 'audio/mpeg' };

  it('creates a pending asset with a real, usable presigned upload URL', async () => {
    const tenantId = crypto.randomUUID();
    const { asset, uploadUrl } = await h.mediaAssets.create(ctxFor(tenantId), VALID_INPUT);

    expect(asset).toMatchObject({
      tenantId,
      kind: 'prompt',
      label: 'Welcome greeting',
      status: 'pending',
      contentType: 'audio/mpeg',
      variant8kKey: null,
      variant16kKey: null,
    });

    // Not just "a URL was returned" — that a bucket-not-provisioned 404 is a
    // real, live failure mode here (not a presign-time one) was confirmed
    // directly against MinIO while building this; this is the regression
    // guard for it.
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'audio/mpeg' },
      body: 'not really mp3 bytes, just proving the URL/bucket work',
    });
    expect(response.ok).toBe(true);

    const fetched = await h.storage.forTenant(tenantId).getObject(asset.objectKey);
    expect(fetched.toString('utf8')).toBe('not really mp3 bytes, just proving the URL/bucket work');
  });

  it('rejects an unknown kind', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.mediaAssets.create(ctxFor(tenantId), { ...VALID_INPUT, kind: 'ringtone' }),
    ).rejects.toThrow(InvalidMediaAssetError);
  });

  it('rejects an unsupported content type', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.mediaAssets.create(ctxFor(tenantId), { ...VALID_INPUT, contentType: 'video/mp4' }),
    ).rejects.toThrow(InvalidMediaAssetError);
  });

  it('finalize moves pending to processing and enqueues pbx.media_asset.finalize_requested', async () => {
    const tenantId = crypto.randomUUID();
    const { asset } = await h.mediaAssets.create(ctxFor(tenantId), VALID_INPUT);

    const finalized = await h.mediaAssets.finalize(ctxFor(tenantId), asset.id);
    expect(finalized.status).toBe('processing');

    const rows = await h.db.kysely
      .selectFrom('outbox')
      .select(['type', 'tenant_id as tenantId', 'payload'])
      .where('type', '=', 'pbx.media_asset.finalize_requested')
      .execute();
    expect(rows).toContainEqual(
      expect.objectContaining({ tenantId, payload: { mediaAssetId: asset.id } }),
    );
  });

  it('refuses to finalize an asset that is already processing', async () => {
    const tenantId = crypto.randomUUID();
    const { asset } = await h.mediaAssets.create(ctxFor(tenantId), VALID_INPUT);
    await h.mediaAssets.finalize(ctxFor(tenantId), asset.id);

    await expect(h.mediaAssets.finalize(ctxFor(tenantId), asset.id)).rejects.toThrow(
      InvalidMediaAssetStatusError,
    );
  });

  it('allows re-finalizing a failed asset (a retry)', async () => {
    const tenantId = crypto.randomUUID();
    const { asset } = await h.mediaAssets.create(ctxFor(tenantId), VALID_INPUT);
    await h.mediaAssets.fail(ctxFor(tenantId), asset.id, 'ffmpeg: invalid data found');

    const refinalized = await h.mediaAssets.finalize(ctxFor(tenantId), asset.id);
    expect(refinalized.status).toBe('processing');
  });

  it('404s finalizing an asset that does not exist', async () => {
    const tenantId = crypto.randomUUID();
    await expect(h.mediaAssets.finalize(ctxFor(tenantId), crypto.randomUUID())).rejects.toThrow(
      MediaAssetNotFoundError,
    );
  });

  it('complete records the transcode result and moves status to ready', async () => {
    const tenantId = crypto.randomUUID();
    const { asset } = await h.mediaAssets.create(ctxFor(tenantId), VALID_INPUT);
    await h.mediaAssets.finalize(ctxFor(tenantId), asset.id);

    const completed = await h.mediaAssets.complete(ctxFor(tenantId), asset.id, {
      durationMs: 4200,
      sha256: 'a'.repeat(64),
      sizeBytes: 65536,
      variant8kKey: `media-assets/${asset.id}/8k.wav`,
      variant16kKey: `media-assets/${asset.id}/16k.wav`,
    });

    expect(completed).toMatchObject({
      status: 'ready',
      durationMs: 4200,
      sha256: 'a'.repeat(64),
      sizeBytes: 65536,
      variant8kKey: `media-assets/${asset.id}/8k.wav`,
      variant16kKey: `media-assets/${asset.id}/16k.wav`,
      errorMessage: null,
    });
  });

  it('fail records the error and moves status to failed', async () => {
    const tenantId = crypto.randomUUID();
    const { asset } = await h.mediaAssets.create(ctxFor(tenantId), VALID_INPUT);
    await h.mediaAssets.finalize(ctxFor(tenantId), asset.id);

    const failed = await h.mediaAssets.fail(
      ctxFor(tenantId),
      asset.id,
      'ffmpeg: invalid data found when processing input',
    );
    expect(failed).toMatchObject({
      status: 'failed',
      errorMessage: 'ffmpeg: invalid data found when processing input',
    });
  });

  it('404s removing an asset that does not exist', async () => {
    const tenantId = crypto.randomUUID();
    await expect(h.mediaAssets.remove(ctxFor(tenantId), crypto.randomUUID())).rejects.toThrow(
      MediaAssetNotFoundError,
    );
  });

  it('removes its own asset', async () => {
    const tenantId = crypto.randomUUID();
    const { asset } = await h.mediaAssets.create(ctxFor(tenantId), VALID_INPUT);
    await h.mediaAssets.remove(ctxFor(tenantId), asset.id);
    expect(await h.mediaAssets.findById(ctxFor(tenantId), asset.id)).toBeUndefined();
  });

  // 05 §2.4: every repository test suite includes a cross-tenant probe.
  crossTenantProbe({
    name: 'media_assets',
    seed: async (tenantId) => {
      const { asset } = await h.mediaAssets.create(ctxFor(tenantId), VALID_INPUT);
      return asset.id;
    },
    list: (tenantId) => h.mediaAssets.list(ctxFor(tenantId)),
    findById: (tenantId, id) => h.mediaAssets.findById(ctxFor(tenantId), id),
    remove: (tenantId, id) =>
      h.mediaAssets
        .remove(ctxFor(tenantId), id)
        .then(() => 1)
        .catch((error: unknown) => {
          if (error instanceof MediaAssetNotFoundError) return 0;
          throw error;
        }),
  });
});
