import { Env, Type } from '@cuc/config';
import type { Logger } from '@cuc/logger';

import { createStorage, type Storage } from './storage.js';

/**
 * Storage configuration every service that touches object storage shares
 * (05 §4). Spread into the service's own schema:
 *
 * ```ts
 * const schema = Type.Object({ ...baseEnvSchema.properties, ...storageEnvSchema.properties });
 * ```
 */
export const storageEnvSchema = Type.Object({
  /**
   * Bucket-per-tenant is the SAD default; prefix-per-tenant exists because
   * some S3-compatible providers cap the number of buckets per account
   * (O-9). Both are implemented — this only chooses which one a deployment
   * uses.
   */
  STORAGE_MODE: Env.enum(['bucket-per-tenant', 'prefix-per-tenant'], {
    default: 'bucket-per-tenant',
  }),
  /**
   * At most 28 characters: the longest bucket name this produces is
   * `{prefix}-t-{32-hex-char tenant id}`, and S3 bucket names cap at 63.
   */
  STORAGE_BUCKET_PREFIX: Env.string({ maxLength: 28 }),
  /** S3-compatible endpoint, e.g. `http://minio:9000` or unset for real AWS S3. */
  STORAGE_ENDPOINT: Env.optional(Env.url()),
  STORAGE_REGION: Env.string({ default: 'us-east-1' }),
  STORAGE_ACCESS_KEY_ID: Env.secret(),
  STORAGE_SECRET_ACCESS_KEY: Env.secret(),
  /**
   * Path-style addressing (`endpoint/bucket/key`) rather than virtual-hosted
   * (`bucket.endpoint/key`). MinIO and most self-hosted S3-compatible
   * providers need this; real AWS S3 works either way but is moving away
   * from path-style, hence the default of `false`.
   */
  STORAGE_FORCE_PATH_STYLE: Env.bool({ default: false }),
});

/** Builds a {@link Storage} from the environment values above. */
export function storageFromConfig(
  config: {
    readonly STORAGE_MODE: 'bucket-per-tenant' | 'prefix-per-tenant';
    readonly STORAGE_BUCKET_PREFIX: string;
    readonly STORAGE_ENDPOINT?: string;
    readonly STORAGE_REGION: string;
    readonly STORAGE_ACCESS_KEY_ID: string;
    readonly STORAGE_SECRET_ACCESS_KEY: string;
    readonly STORAGE_FORCE_PATH_STYLE: boolean;
  },
  logger: Logger,
): Storage {
  return createStorage({
    mode: config.STORAGE_MODE,
    bucketPrefix: config.STORAGE_BUCKET_PREFIX,
    ...(config.STORAGE_ENDPOINT === undefined ? {} : { endpoint: config.STORAGE_ENDPOINT }),
    region: config.STORAGE_REGION,
    accessKeyId: config.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: config.STORAGE_SECRET_ACCESS_KEY,
    forcePathStyle: config.STORAGE_FORCE_PATH_STYLE,
    logger,
  });
}
