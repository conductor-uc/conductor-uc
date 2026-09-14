import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Logger } from '@cuc/logger';

import { locatePlatformObject, locateTenantObject, type ObjectLocation } from './bucket-naming.js';
import {
  MAX_GET_TTL_SECONDS,
  MAX_PUT_TTL_SECONDS,
  type LifecycleRule,
  type PresignOptions,
  type PresignPutOptions,
  type StorageMode,
} from './types.js';

export interface CreateStorageOptions {
  readonly mode: StorageMode;
  readonly bucketPrefix: string;
  readonly endpoint?: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle?: boolean;
  readonly logger: Logger;
  /** Injected in tests against a real MinIO/S3; otherwise built from the options above. */
  readonly client?: S3Client;
}

export interface ScopedStorage {
  /** Where `key` actually lives — the bucket and the real key, after mode-dependent resolution. */
  locate(key: string): ObjectLocation;
  presignGet(key: string, options?: PresignOptions): Promise<string>;
  presignPut(key: string, options?: PresignPutOptions): Promise<string>;
  /**
   * Creates this scope's bucket if it does not exist yet, with server-side
   * encryption and a public-access block (05 §4). Idempotent: a bucket that
   * already exists is left alone, not recreated.
   *
   * Encryption and the public-access block are attempted, not required —
   * not every S3-compatible provider implements them (MinIO does not
   * support `PutPublicAccessBlock` at all, and needs KMS configured before
   * it accepts `PutBucketEncryption`, confirmed against a real MinIO
   * server). A provider that cannot honor one logs a warning and the bucket
   * still gets created; real S3 honors both.
   */
  provisionBucket(): Promise<void>;
  setLifecycleRule(rule: LifecycleRule): Promise<void>;
}

export interface Storage {
  forTenant(tenantId: string): ScopedStorage;
  forPlatform(): ScopedStorage;
}

/** True once `bucket` has been provisioned this process — avoids re-issuing the same calls on every request. */
function makeProvisionCache(): { has(bucket: string): boolean; add(bucket: string): void } {
  const seen = new Set<string>();
  return {
    has: (bucket) => seen.has(bucket),
    add: (bucket) => seen.add(bucket),
  };
}

export function createStorage(options: CreateStorageOptions): Storage {
  const client =
    options.client ??
    new S3Client({
      region: options.region,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
      ...(options.forcePathStyle === undefined ? {} : { forcePathStyle: options.forcePathStyle }),
    });
  const logger = options.logger;
  const provisioned = makeProvisionCache();

  async function ensureBucket(bucket: string): Promise<void> {
    if (provisioned.has(bucket)) return;

    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (error) {
      if (!isBucketAlreadyOwned(error)) {
        try {
          await client.send(new HeadBucketCommand({ Bucket: bucket }));
        } catch {
          throw error;
        }
      }
    }

    await attempt(logger, `enable default encryption on '${bucket}'`, () =>
      client.send(
        new PutBucketEncryptionCommand({
          Bucket: bucket,
          ServerSideEncryptionConfiguration: {
            Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
          },
        }),
      ),
    );
    await attempt(logger, `block public access on '${bucket}'`, () =>
      client.send(
        new PutPublicAccessBlockCommand({
          Bucket: bucket,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        }),
      ),
    );

    provisioned.add(bucket);
  }

  async function setLifecycleRule(bucket: string, rule: LifecycleRule): Promise<void> {
    await client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        LifecycleConfiguration: {
          Rules: [
            {
              ID: rule.id,
              Filter: { Prefix: rule.prefix },
              Status: 'Enabled',
              Expiration: { Days: rule.expirationDays },
            },
          ],
        },
      }),
    );
  }

  function scopeFor(locate: (key: string) => ObjectLocation): ScopedStorage {
    return {
      locate,
      async presignGet(key, presignOptions) {
        const { bucket, key: realKey } = locate(key);
        return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: realKey }), {
          expiresIn: clampTtl(presignOptions?.ttlSeconds, MAX_GET_TTL_SECONDS),
        });
      },
      async presignPut(key, presignOptions) {
        const { bucket, key: realKey } = locate(key);
        return getSignedUrl(
          client,
          new PutObjectCommand({
            Bucket: bucket,
            Key: realKey,
            ...(presignOptions?.contentType === undefined
              ? {}
              : { ContentType: presignOptions.contentType }),
          }),
          { expiresIn: clampTtl(presignOptions?.ttlSeconds, MAX_PUT_TTL_SECONDS) },
        );
      },
      async provisionBucket() {
        await ensureBucket(locate('').bucket);
      },
      async setLifecycleRule(rule) {
        await setLifecycleRule(locate('').bucket, rule);
      },
    };
  }

  return {
    forTenant(tenantId) {
      return scopeFor((key) =>
        locateTenantObject(options.mode, options.bucketPrefix, tenantId, key),
      );
    },
    forPlatform() {
      return scopeFor((key) => locatePlatformObject(options.bucketPrefix, key));
    },
  };
}

function clampTtl(requested: number | undefined, max: number): number {
  if (requested === undefined) return max;
  return Math.min(Math.max(requested, 1), max);
}

function isBucketAlreadyOwned(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    (error.name === 'BucketAlreadyOwnedByYou' || error.name === 'BucketAlreadyExists')
  );
}

async function attempt(
  logger: Logger,
  description: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      `Could not ${description} — this S3-compatible provider may not support it.`,
    );
  }
}
