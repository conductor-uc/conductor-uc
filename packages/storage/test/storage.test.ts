import { randomUUID } from 'node:crypto';
import {
  GetBucketCorsCommand,
  GetBucketLifecycleConfigurationCommand,
  S3Client,
  type CORSRule,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@cuc/logger';
import { s3OrSkipReason, silentLogger, startTestS3, type TestS3Handle } from '@cuc/testing';

import { BROWSER_CORS_RULE } from '../src/cors.js';
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

  /** One prefix per run for tests that need two `Storage` instances on the same buckets. */
  const fixedPrefix = `cuc-test-${randomUUID().slice(0, 8)}`;

  function makeStorage(
    mode: 'bucket-per-tenant' | 'prefix-per-tenant',
    logger: Logger = silentLogger(),
    prefix: 'fresh' | 'fixed' = 'fresh',
  ): Storage {
    return createStorage({
      mode,
      bucketPrefix: prefix === 'fixed' ? fixedPrefix : `cuc-test-${randomUUID().slice(0, 8)}`,
      endpoint: handle.endpoint,
      region: handle.region,
      accessKeyId: handle.accessKeyId,
      secretAccessKey: handle.secretAccessKey,
      forcePathStyle: handle.forcePathStyle,
      logger,
    });
  }

  function rawClient(): S3Client {
    return new S3Client({
      region: handle.region,
      endpoint: handle.endpoint,
      forcePathStyle: handle.forcePathStyle,
      credentials: { accessKeyId: handle.accessKeyId, secretAccessKey: handle.secretAccessKey },
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

      it('sets the browser CORS rule, or warns when the provider refuses it, and a browser can upload', async () => {
        const logger = silentLogger();
        const warn = vi.spyOn(logger, 'warn');
        const storage = makeStorage(mode, logger);
        const tenant = storage.forTenant(randomUUID());
        await tenant.provisionBucket();

        // Either outcome is fine (G-80): real S3 stores the rule; MinIO answers
        // NotImplemented because it allows any origin already.
        const { bucket } = tenant.locate('');
        let stored: CORSRule[] | undefined;
        try {
          stored = (await rawClient().send(new GetBucketCorsCommand({ Bucket: bucket }))).CORSRules;
        } catch (error) {
          expect(error).toMatchObject({ name: 'NoSuchCORSConfiguration' });
        }
        const warned = warn.mock.calls.some((call) =>
          String(call[1]).includes('browser CORS rule'),
        );
        if (stored === undefined) {
          expect(warned).toBe(true);
        } else {
          expect(warned).toBe(false);
          expect(stored).toEqual([expect.objectContaining(BROWSER_CORS_RULE)]);
        }

        // What a browser does from the console's origin: preflight, then the upload.
        const putUrl = await tenant.presignPut('media-assets/x/raw', { contentType: 'audio/wav' });
        const origin = 'https://console.example.test';
        const preflight = await fetch(putUrl, {
          method: 'OPTIONS',
          headers: {
            origin,
            'access-control-request-method': 'PUT',
            'access-control-request-headers': 'content-type',
          },
        });
        expect(preflight.ok).toBe(true);
        expect(['*', origin]).toContain(preflight.headers.get('access-control-allow-origin'));
        const put = await fetch(putUrl, {
          method: 'PUT',
          headers: { origin, 'content-type': 'audio/wav' },
          body: 'RIFF',
        });
        expect(put.ok).toBe(true);
        expect(['*', origin]).toContain(put.headers.get('access-control-allow-origin'));
      });

      it('presigning in a bucket provisioned elsewhere does not fail on the CORS step', async () => {
        const logger = silentLogger();
        const tenantId = randomUUID();
        await makeStorage(mode, logger, 'fixed').forTenant(tenantId).provisionBucket();

        // A fresh process (new storage, empty cache) touching the existing bucket.
        const later = makeStorage(mode, logger, 'fixed').forTenant(tenantId);
        const putUrl = await later.presignPut('greeting.txt', { contentType: 'text/plain' });
        expect((await upload(putUrl, 'still works')).ok).toBe(true);
        expect(await download(await later.presignGet('greeting.txt'))).toBe('still works');
      });

      it('reports the size and ETag with headObject, and undefined for a missing one', async () => {
        const storage = makeStorage(mode);
        const tenant = storage.forTenant(randomUUID());
        await tenant.provisionBucket();
        await tenant.putObject('a/b.bin', Buffer.from('12345'));

        const head = await tenant.headObject('a/b.bin');
        expect(head?.sizeBytes).toBe(5);
        // MD5 of '12345' (single-part upload, no KMS).
        expect(head?.etag).toBe('827ccb0eea8a706c4c34a16891f84e7b');
        expect(await tenant.headObject('a/missing.bin')).toBeUndefined();
      });

      it('a presigned GET can force a download with responseContentDisposition', async () => {
        const storage = makeStorage(mode);
        const tenant = storage.forTenant(randomUUID());
        await tenant.provisionBucket();
        await tenant.putObject('x.wav', Buffer.from('abc'));

        const response = await fetch(
          await tenant.presignGet('x.wav', {
            responseContentDisposition: 'attachment; filename="x.wav"',
          }),
        );
        expect(response.headers.get('content-disposition')).toBe('attachment; filename="x.wav"');
      });

      it('deletes an object, and deleting a missing one is not an error', async () => {
        const storage = makeStorage(mode);
        const tenant = storage.forTenant(randomUUID());
        await tenant.provisionBucket();
        await tenant.putObject('gone.bin', Buffer.from('x'));

        await tenant.deleteObject('gone.bin');
        expect(await tenant.headObject('gone.bin')).toBeUndefined();
        await expect(tenant.deleteObject('gone.bin')).resolves.toBeUndefined();
      });

      it('adds a second lifecycle rule without dropping the first, and replaces one by id', async () => {
        const storage = makeStorage(mode);
        const tenant = storage.forTenant(randomUUID());
        await tenant.provisionBucket();

        await tenant.setLifecycleRule({ id: 'r1', prefix: 'recordings/', expirationDays: 30 });
        await tenant.setLifecycleRule({ id: 'r2', prefix: 'exports/', expirationDays: 7 });
        await tenant.setLifecycleRule({ id: 'r1', prefix: 'recordings/', expirationDays: 60 });

        const client = new S3Client({
          region: handle.region,
          endpoint: handle.endpoint,
          forcePathStyle: handle.forcePathStyle,
          credentials: { accessKeyId: handle.accessKeyId, secretAccessKey: handle.secretAccessKey },
        });
        const { bucket, key } = tenant.locate('recordings/');
        const rules =
          (await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })))
            .Rules ?? [];
        expect(rules.map((rule) => rule.ID).sort()).toEqual(['r1', 'r2']);
        const r1 = rules.find((rule) => rule.ID === 'r1');
        expect(r1?.Expiration?.Days).toBe(60);
        // The rule covers the real key prefix (tenant-prefixed in prefix-per-tenant mode).
        expect(r1?.Filter?.Prefix ?? r1?.Prefix).toBe(key);

        await tenant.removeLifecycleRule('r1');
        await tenant.removeLifecycleRule('r1'); // already gone: fine
        await tenant.removeLifecycleRule('r2');
        await expect(
          client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })),
        ).rejects.toMatchObject({ name: 'NoSuchLifecycleConfiguration' });
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
