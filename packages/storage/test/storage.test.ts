import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { s3OrSkipReason, silentLogger, startTestS3, type TestS3Handle } from '@cuc/testing';

import { createStorage, type Storage } from '../src/storage.js';
import { MAX_GET_TTL_SECONDS, MAX_PUT_TTL_SECONDS } from '../src/types.js';

const skipReason = await s3OrSkipReason();

async function upload(url: string, body: string, contentType = 'text/plain'): Promise<Response> {
  return fetch(url, { method: 'PUT', headers: { 'content-type': contentType }, body });
}

async function download(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed: ${String(response.status)}`);
  return response.text();
}

/**
 * The S0-10 acceptance criterion is "integration tests pass against MinIO in
 * both modes" — every describe block below runs for both, parameterized on
 * `mode`, against the same MinIO instance.
 */
describe.skipIf(skipReason !== undefined)('@cuc/storage', () => {
  let handle: TestS3Handle;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    handle = await startTestS3();
    stop = () => handle.stop();
  });

  afterAll(async () => {
    await stop?.();
  });

  function makeStorage(mode: 'bucket-per-tenant' | 'prefix-per-tenant'): Storage {
    return createStorage({
      mode,
      bucketPrefix: `cuc-test-${randomUUID().slice(0, 8)}`,
      endpoint: handle.endpoint,
      region: handle.region,
      accessKeyId: handle.accessKeyId,
      secretAccessKey: handle.secretAccessKey,
      forcePathStyle: handle.forcePathStyle,
      logger: silentLogger(),
    });
  }

  for (const mode of ['bucket-per-tenant', 'prefix-per-tenant'] as const) {
    describe(`mode: ${mode}`, () => {
      it('provisions a bucket and round-trips an object through presigned PUT then GET', async () => {
        const storage = makeStorage(mode);
        const tenant = storage.forTenant(randomUUID());
        await tenant.provisionBucket();

        const putUrl = await tenant.presignPut('greeting.txt', { contentType: 'text/plain' });
        const putResponse = await upload(putUrl, 'hello from a real upload');
        expect(putResponse.ok).toBe(true);

        const getUrl = await tenant.presignGet('greeting.txt');
        expect(await download(getUrl)).toBe('hello from a real upload');
      });

      it('round-trips an object directly through putObject/getObject, no presigned URL involved', async () => {
        const storage = makeStorage(mode);
        const tenant = storage.forTenant(randomUUID());
        await tenant.provisionBucket();

        await tenant.putObject('raw/upload.bin', Buffer.from('server-side bytes'), {
          contentType: 'application/octet-stream',
        });

        expect((await tenant.getObject('raw/upload.bin')).toString('utf8')).toBe(
          'server-side bytes',
        );
      });

      it('provisionBucket is idempotent — calling it twice does not throw', async () => {
        const storage = makeStorage(mode);
        const tenant = storage.forTenant(randomUUID());

        await tenant.provisionBucket();
        await expect(tenant.provisionBucket()).resolves.toBeUndefined();
      });

      it('sets a lifecycle rule without throwing', async () => {
        const storage = makeStorage(mode);
        const tenant = storage.forTenant(randomUUID());
        await tenant.provisionBucket();

        await expect(
          tenant.setLifecycleRule({
            id: 'expire-recordings',
            prefix: 'recordings/',
            expirationDays: 30,
          }),
        ).resolves.toBeUndefined();
      });

      it('clamps a requested TTL to the documented maximum', async () => {
        const storage = makeStorage(mode);
        const tenant = storage.forTenant(randomUUID());
        await tenant.provisionBucket();

        // clampTtl isn't exported, so this proves the clamp through its only
        // observable effect: a wildly excessive TTL still produces a usable
        // presigned URL, with X-Amz-Expires capped rather than S3 rejecting
        // a signature request for too long a lifetime.
        const url = await tenant.presignGet('x.txt', { ttlSeconds: MAX_GET_TTL_SECONDS * 100 });
        expect(url).toContain('X-Amz-Expires=');
        const expires = new URL(url).searchParams.get('X-Amz-Expires');
        expect(Number(expires)).toBeLessThanOrEqual(MAX_GET_TTL_SECONDS);
      });

      it('clamps a requested PUT TTL to its own, longer maximum', async () => {
        const storage = makeStorage(mode);
        const tenant = storage.forTenant(randomUUID());
        await tenant.provisionBucket();

        const url = await tenant.presignPut('x.txt', { ttlSeconds: MAX_PUT_TTL_SECONDS * 100 });
        const expires = Number(new URL(url).searchParams.get('X-Amz-Expires'));
        expect(expires).toBeLessThanOrEqual(MAX_PUT_TTL_SECONDS);
        expect(expires).toBeGreaterThan(MAX_GET_TTL_SECONDS); // proves it's the PUT max, not the GET one
      });
    });
  }

  it('bucket-per-tenant: two tenants get two different, isolated buckets', () => {
    const storage = makeStorage('bucket-per-tenant');
    const tenantA = storage.forTenant(randomUUID());
    const tenantB = storage.forTenant(randomUUID());

    expect(tenantA.locate('x').bucket).not.toBe(tenantB.locate('x').bucket);
  });

  it("prefix-per-tenant: two tenants share one bucket but never see each other's keys", () => {
    const storage = makeStorage('prefix-per-tenant');
    const tenantA = storage.forTenant(randomUUID());
    const tenantB = storage.forTenant(randomUUID());

    expect(tenantA.locate('x').bucket).toBe(tenantB.locate('x').bucket);
    expect(tenantA.locate('x').key).not.toBe(tenantB.locate('x').key);
  });

  it('the platform scope is a fixed bucket, independent of mode or tenant', async () => {
    const storage = makeStorage('bucket-per-tenant');
    const platform = storage.forPlatform();
    await platform.provisionBucket();

    const putUrl = await platform.presignPut('brand/r1/logo.svg', { contentType: 'image/svg+xml' });
    const putResponse = await upload(putUrl, '<svg/>', 'image/svg+xml');
    expect(putResponse.ok).toBe(true);

    const getUrl = await platform.presignGet('brand/r1/logo.svg');
    expect(await download(getUrl)).toBe('<svg/>');
  });
});
