export type StorageMode = 'bucket-per-tenant' | 'prefix-per-tenant';

/**
 * Maximum presigned-URL lifetimes (05 §4): downloads are short because a
 * leaked GET URL exposes the object itself; uploads get a little longer
 * because a slow client needs time to actually push the bytes.
 */
export const MAX_GET_TTL_SECONDS = 5 * 60;
export const MAX_PUT_TTL_SECONDS = 15 * 60;

export interface PresignOptions {
  /** Clamped to {@link MAX_GET_TTL_SECONDS} / {@link MAX_PUT_TTL_SECONDS}. Defaults to the max. */
  readonly ttlSeconds?: number;
  /**
   * `presignGet` only: what the download response's `Content-Disposition` header should say,
   * e.g. `attachment; filename="x.wav"`, so a browser saves the file instead of playing it.
   */
  readonly responseContentDisposition?: string;
}

export interface PresignPutOptions extends PresignOptions {
  readonly contentType?: string;
}

export interface PutObjectOptions {
  readonly contentType?: string;
}

/**
 * An S3 lifecycle rule, restated to the one shape every call site of this
 * package needs — expire objects under a prefix after N days. A tenant's
 * retention policy (05 §4) is the caller of this, one rule per data
 * category (recordings, voicemail, exports, …).
 */
export interface LifecycleRule {
  /** Unique within the bucket. Re-using an id replaces that rule. */
  readonly id: string;
  /** Only objects whose key starts with this are covered. */
  readonly prefix: string;
  readonly expirationDays: number;
}
