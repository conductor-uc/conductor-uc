import type { StorageMode } from './types.js';

/**
 * Pure bucket/key resolution (05 §4). No I/O here — `storage.ts` is where
 * these names meet an actual S3 client.
 */

/**
 * A tenant id (UUIDv7, with hyphens) reduced to a bucket-name-safe form:
 * lowercase hex, no hyphens. Deterministic and collision-free — it's the
 * same id, just without the characters S3 bucket-naming style avoids
 * repeating this often in one name.
 */
export function tenantShortId(tenantId: string): string {
  return tenantId.replaceAll('-', '').toLowerCase();
}

/** `{prefix}-t-{tenantShortId}` — the bucket-per-tenant mode's bucket name (05 §4). */
export function tenantBucketName(prefix: string, tenantId: string): string {
  return `${prefix}-t-${tenantShortId(tenantId)}`;
}

/** The one shared bucket every tenant's objects live in under prefix-per-tenant mode. */
export function sharedBucketName(prefix: string): string {
  return `${prefix}-shared`;
}

/** `{prefix}-platform` — reseller/platform-scoped objects, e.g. brand assets (05 §4). Fixed regardless of `STORAGE_MODE`. */
export function platformBucketName(prefix: string): string {
  return `${prefix}-platform`;
}

export interface ObjectLocation {
  readonly bucket: string;
  readonly key: string;
}

/**
 * Where `key` actually lives for a tenant, given `mode`: its own bucket
 * (bucket-per-tenant) or a tenant-id-prefixed key in the shared bucket
 * (prefix-per-tenant). The caller's `key` never changes shape — only where
 * it resolves to does.
 */
export function locateTenantObject(
  mode: StorageMode,
  prefix: string,
  tenantId: string,
  key: string,
): ObjectLocation {
  if (mode === 'bucket-per-tenant') return { bucket: tenantBucketName(prefix, tenantId), key };
  return { bucket: sharedBucketName(prefix), key: `t-${tenantShortId(tenantId)}/${key}` };
}

/** Where `key` lives in the platform (reseller-scoped) bucket. */
export function locatePlatformObject(prefix: string, key: string): ObjectLocation {
  return { bucket: platformBucketName(prefix), key };
}
