export class InvalidMediaAssetError extends Error {
  override readonly name = 'InvalidMediaAssetError';
}

export const MEDIA_ASSET_KINDS = ['prompt', 'moh', 'greeting'] as const;
export type MediaAssetKind = (typeof MEDIA_ASSET_KINDS)[number];

/**
 * The upload -> finalize -> transcode lifecycle (S2-07). `pending`: the row
 * exists and a presigned PUT was handed out, but nothing has confirmed the
 * upload landed. `processing`: `:finalize` was called and
 * `pbx.media_asset.finalize_requested` is enqueued/in flight at the
 * transcode worker. `ready`/`failed`: the worker's own callback
 * (`internal.routes.ts`).
 */
export const MEDIA_ASSET_STATUSES = ['pending', 'processing', 'ready', 'failed'] as const;
export type MediaAssetStatus = (typeof MEDIA_ASSET_STATUSES)[number];

/**
 * What this service accepts as a raw upload's declared content type — a
 * courtesy restriction at the API boundary, not a security one:
 * `ffmpeg` (the transcode worker) is what actually accepts or rejects the
 * real bytes, regardless of what a client claimed here.
 */
const ALLOWED_CONTENT_TYPES = ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mp4'];

const MAX_LABEL_LENGTH = 255;

export function validateLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed === '') throw new InvalidMediaAssetError('label must not be empty.');
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new InvalidMediaAssetError(
      `label must be at most ${String(MAX_LABEL_LENGTH)} characters.`,
    );
  }
  return trimmed;
}

export function validateKind(kind: string): MediaAssetKind {
  if (!(MEDIA_ASSET_KINDS as readonly string[]).includes(kind)) {
    throw new InvalidMediaAssetError(`kind must be one of ${MEDIA_ASSET_KINDS.join(', ')}.`);
  }
  return kind as MediaAssetKind;
}

export function validateContentType(contentType: string): string {
  const normalized = contentType.trim().toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.includes(normalized)) {
    throw new InvalidMediaAssetError(
      `contentType must be one of ${ALLOWED_CONTENT_TYPES.join(', ')}.`,
    );
  }
  return normalized;
}
