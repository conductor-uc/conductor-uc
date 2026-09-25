import {
  CreateBucketCommand,
  PutBucketCorsCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '@cuc/testing';

import { BROWSER_CORS_RULE } from '../src/cors.js';
import { createStorage } from '../src/storage.js';

const TENANT = '0b5c6a52-2f5e-4a7b-9d1c-3f0e8a4b6c7d';
const OTHER_TENANT = '5e1d2c3b-4a59-4687-8b7a-6c5d4e3f2a1b';

function s3Error(name: string): S3ServiceException {
  return new S3ServiceException({ name, $fault: 'client', $metadata: {}, message: name });
}

/**
 * A real client (presigning needs its config) whose `send` is replaced, so every
 * request is recorded and nothing goes over the network. `reply` decides each answer.
 */
function fakeClient(reply: (command: unknown) => unknown = () => ({})) {
  const client = new S3Client({
    region: 'us-east-1',
    endpoint: 'http://storage.invalid',
    forcePathStyle: true,
    credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
  });
  const sent: unknown[] = [];
  const send = async (command: unknown): Promise<unknown> => {
    sent.push(command);
    return await Promise.resolve().then(() => reply(command));
  };
  // `send` is overloaded (it also takes a callback), which no plain function type matches.
  vi.spyOn(client, 'send').mockImplementation(send as never);
  const corsCalls = () =>
    sent.filter((c): c is PutBucketCorsCommand => c instanceof PutBucketCorsCommand);
  return { client, sent, corsCalls };
}

function storageWith(client: S3Client, logger = silentLogger()) {
  return createStorage({
    mode: 'bucket-per-tenant',
    bucketPrefix: 'cuc-unit',
    region: 'us-east-1',
    accessKeyId: 'a',
    secretAccessKey: 'b',
    logger,
    client,
  });
}

describe('browser CORS rule (G-80)', () => {
  it('provisioning a bucket sends exactly the documented rule', async () => {
    const fake = fakeClient();
    const tenant = storageWith(fake.client).forTenant(TENANT);

    await tenant.provisionBucket();

    expect(fake.corsCalls()).toHaveLength(1);
    expect(fake.corsCalls()[0]!.input).toEqual({
      Bucket: tenant.locate('').bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedMethods: ['PUT', 'GET', 'HEAD'],
            AllowedOrigins: ['*'],
            AllowedHeaders: ['Content-Type'],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    });
    // No ExposeHeaders and no credentials setting: nothing reads them.
    expect(BROWSER_CORS_RULE).not.toHaveProperty('ExposeHeaders');
  });

  it('applies the rule to an existing bucket the first time a URL is presigned in it, once per process', async () => {
    const fake = fakeClient();
    const tenant = storageWith(fake.client).forTenant(TENANT);

    // Concurrent first touches share one request.
    await Promise.all([
      tenant.presignPut('media-assets/a/raw', { contentType: 'audio/wav' }),
      tenant.presignGet('media-assets/b/16k.wav'),
    ]);
    await tenant.presignPut('media-assets/c/raw');
    await tenant.provisionBucket();

    expect(fake.corsCalls()).toHaveLength(1);
    expect(fake.corsCalls()[0]!.input.Bucket).toBe(tenant.locate('').bucket);
    // Presigning alone never creates a bucket.
    expect(fake.sent.filter((c) => c instanceof CreateBucketCommand)).toHaveLength(1);
  });

  for (const refusal of ['NotImplemented', 'AccessDenied']) {
    it(`a provider-wide refusal (${refusal}) warns once per process and stops trying for every bucket`, async () => {
      const fake = fakeClient((command) => {
        if (command instanceof PutBucketCorsCommand) throw s3Error(refusal);
        return {};
      });
      const logger = silentLogger();
      const warn = vi.spyOn(logger, 'warn');
      const storage = storageWith(fake.client, logger);
      const tenant = storage.forTenant(TENANT);

      await tenant.provisionBucket();
      await expect(tenant.presignPut('x')).resolves.toContain('X-Amz-Signature=');
      // Other buckets, including concurrent first touches, are not asked at all.
      await Promise.all([
        storage.forTenant(OTHER_TENANT).presignPut('x'),
        storage.forPlatform().presignGet('brand/r1/logo'),
      ]);
      await storage.forTenant(OTHER_TENANT).provisionBucket();

      expect(fake.corsCalls()).toHaveLength(1);
      const corsWarnings = warn.mock.calls.filter((call) =>
        String(call[1]).includes('browser CORS rule'),
      );
      expect(corsWarnings).toHaveLength(1);
      expect(String(corsWarnings[0]![1])).toContain(refusal);
      expect(String(corsWarnings[0]![1])).toContain('dns-tls-and-certificates.md');
    });
  }

  it('a provider-wide refusal answered to concurrent first touches still warns once', async () => {
    const fake = fakeClient((command) => {
      if (command instanceof PutBucketCorsCommand) throw s3Error('NotImplemented');
      return {};
    });
    const logger = silentLogger();
    const warn = vi.spyOn(logger, 'warn');
    const storage = storageWith(fake.client, logger);

    await Promise.all([
      storage.forTenant(TENANT).presignPut('x'),
      storage.forTenant(OTHER_TENANT).presignPut('x'),
      storage.forPlatform().presignPut('x'),
    ]);

    expect(fake.corsCalls()).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('any other failure warns for that bucket only, and other buckets are still tried', async () => {
    const fake = fakeClient((command) => {
      if (command instanceof PutBucketCorsCommand) throw s3Error('InternalError');
      return {};
    });
    const logger = silentLogger();
    const warn = vi.spyOn(logger, 'warn');
    const storage = storageWith(fake.client, logger);

    await storage.forTenant(TENANT).presignPut('x');
    await storage.forTenant(TENANT).presignPut('y'); // not retried for the same bucket
    await storage.forTenant(OTHER_TENANT).presignPut('x');

    expect(fake.corsCalls().map((c) => c.input.Bucket)).toEqual([
      storage.forTenant(TENANT).locate('').bucket,
      storage.forTenant(OTHER_TENANT).locate('').bucket,
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('a bucket that does not exist yet is tried again on the next touch', async () => {
    let exists = false;
    const fake = fakeClient((command) => {
      if (command instanceof PutBucketCorsCommand && !exists) throw s3Error('NoSuchBucket');
      return {};
    });
    const logger = silentLogger();
    const warn = vi.spyOn(logger, 'warn');
    const platform = storageWith(fake.client, logger).forPlatform();

    await platform.presignPut('brand/r1/logo');
    exists = true;
    await platform.presignPut('brand/r1/logo');
    await platform.presignPut('brand/r1/logo');

    expect(fake.corsCalls()).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
  });
});
