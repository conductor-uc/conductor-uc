import {
  CreateBucketCommand,
  DeleteBucketLifecycleCommand,
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  S3ServiceException,
  type LifecycleRule as S3LifecycleRule,
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
  type PutObjectOptions,
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
   * Reads an object's bytes directly, server-side — unlike `presignGet`,
   * which only ever hands a *client* a URL. For a small, trusted, own-process
   * workload only (S2-07's own transcode worker fetching a tenant's raw
   * upload to feed `ffmpeg`): whole-object-in-memory, no streaming, since
   * every caller so far is short voice media, not anything approaching a
   * size where that would matter.
   */
  getObject(key: string): Promise<Buffer>;
  /** The write half of {@link getObject} — writes bytes directly rather than handing a client a presigned PUT URL. */
  putObject(key: string, body: Buffer, options?: PutObjectOptions): Promise<void>;
  /**
   * The object's size and ETag without reading it, or `undefined` when it does not exist.
   * For a single-part upload without KMS the ETag is the object's MD5 in hex, quotes removed
   * (recording-service uses that to verify an upload); a multipart or KMS-encrypted object
   * has an opaque one.
   */
  headObject(key: string): Promise<{ sizeBytes: number; etag: string | null } | undefined>;
  /** Deletes one object. Deleting one that is already gone is not an error (S3 semantics). */
  deleteObject(key: string): Promise<void>;
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
  /** Removes the rule with this id if there is one; the bucket's other rules stay. */
  removeLifecycleRule(id: string): Promise<void>;
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

  /**
   * Adds or replaces one rule, keeping the bucket's other rules: S3's API replaces the whole
   * configuration, so this reads it first. `prefix` is already the real key prefix.
   */
  async function setLifecycleRule(
    bucket: string,
    rule: LifecycleRule,
    realPrefix: string,
  ): Promise<void> {
    let existing: S3LifecycleRule[] = [];
    try {
      const current = await client.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
      );
      existing = current.Rules ?? [];
    } catch (error) {
      if (!(error instanceof S3ServiceException) || error.name !== 'NoSuchLifecycleConfiguration') {
        throw error;
      }
    }

    await client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        LifecycleConfiguration: {
          Rules: [
            ...existing.filter((other) => other.ID !== rule.id),
            {
              ID: rule.id,
              Filter: { Prefix: realPrefix },
              Status: 'Enabled',
              Expiration: { Days: rule.expirationDays },
            },
          ],
        },
      }),
    );
  }

  /** Removes one rule by id, keeping the others; a bucket left with none has its configuration deleted. */
  async function removeLifecycleRule(bucket: string, id: string): Promise<void> {
    let existing: S3LifecycleRule[];
    try {
      existing =
        (await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }))).Rules ??
        [];
    } catch (error) {
      if (error instanceof S3ServiceException && error.name === 'NoSuchLifecycleConfiguration')
        return;
      throw error;
    }
    const remaining = existing.filter((rule) => rule.ID !== id);
    if (remaining.length === existing.length) return;
    if (remaining.length === 0) {
      await client.send(new DeleteBucketLifecycleCommand({ Bucket: bucket }));
      return;
    }
    await client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        LifecycleConfiguration: { Rules: remaining },
      }),
    );
  }

  function scopeFor(locate: (key: string) => ObjectLocation): ScopedStorage {
    return {
      locate,
      async presignGet(key, presignOptions) {
        const { bucket, key: realKey } = locate(key);
        return getSignedUrl(
          client,
          new GetObjectCommand({
            Bucket: bucket,
            Key: realKey,
            ...(presignOptions?.responseContentDisposition === undefined
              ? {}
              : { ResponseContentDisposition: presignOptions.responseContentDisposition }),
          }),
          { expiresIn: clampTtl(presignOptions?.ttlSeconds, MAX_GET_TTL_SECONDS) },
        );
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
      async getObject(key) {
        const { bucket, key: realKey } = locate(key);
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: realKey }));
        if (result.Body === undefined) {
          throw new Error(`Object '${key}' in bucket '${bucket}' has no body.`);
        }
        return Buffer.from(await result.Body.transformToByteArray());
      },
      async putObject(key, body, putOptions) {
        const { bucket, key: realKey } = locate(key);
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: realKey,
            Body: body,
            ...(putOptions?.contentType === undefined
              ? {}
              : { ContentType: putOptions.contentType }),
          }),
        );
      },
      async headObject(key) {
        const { bucket, key: realKey } = locate(key);
        try {
          const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: realKey }));
          return {
            sizeBytes: result.ContentLength ?? 0,
            etag: result.ETag === undefined ? null : result.ETag.replaceAll('"', ''),
          };
        } catch (error) {
          if (
            error instanceof S3ServiceException &&
            (error.name === 'NotFound' || error.name === 'NoSuchKey')
          ) {
            return undefined;
          }
          throw error;
        }
      },
      async deleteObject(key) {
        const { bucket, key: realKey } = locate(key);
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: realKey }));
      },
      async provisionBucket() {
        await ensureBucket(locate('').bucket);
      },
      async removeLifecycleRule(id) {
        await removeLifecycleRule(locate('').bucket, id);
      },
      async setLifecycleRule(rule) {
        // The rule's prefix names keys as callers know them; in prefix-per-tenant mode the real
        // keys carry the tenant's own prefix in front, and the rule must cover exactly those.
        const { bucket, key: realPrefix } = locate(rule.prefix);
        await setLifecycleRule(bucket, rule, realPrefix);
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
