import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { requireTenant } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';
import { MAX_GET_TTL_SECONDS, type Storage } from '@cuc/storage';

import {
  validateContentType,
  validateKind,
  validateLabel,
  type MediaAssetKind,
  type MediaAssetStatus,
} from '../domain/media-asset.js';
import { pbxEvents } from '../events.js';
import type { PbxConfigServiceDb } from '../schema.js';

export interface MediaAsset {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: MediaAssetKind;
  readonly label: string;
  readonly status: MediaAssetStatus;
  readonly contentType: string;
  readonly objectKey: string;
  readonly variant8kKey: string | null;
  readonly variant16kKey: string | null;
  readonly durationMs: number | null;
  readonly sha256: string | null;
  readonly sizeBytes: number | null;
  readonly errorMessage: string | null;
}

export interface CreateMediaAssetInput {
  readonly kind: string;
  readonly label: string;
  readonly contentType: string;
}

/** What the transcode worker reports back through `:complete` (`internal.routes.ts`). */
export interface TranscodeResult {
  readonly durationMs: number;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly variant8kKey: string;
  readonly variant16kKey: string;
}

/** Which converted copy of a ready asset to play: 16 kHz (the better one) or 8 kHz. */
export type MediaAssetVariant = '8k' | '16k';

/** A short-lived address to fetch an asset's audio from, and when it stops working. */
export interface MediaAssetDownload {
  readonly url: string;
  readonly expiresAt: Date;
}

export class MediaAssetNotFoundError extends Error {
  override readonly name = 'MediaAssetNotFoundError';
}

export class InvalidMediaAssetStatusError extends Error {
  override readonly name = 'InvalidMediaAssetStatusError';
}

const COLUMNS = [
  'id',
  'tenant_id as tenantId',
  'kind',
  'label',
  'status',
  'content_type as contentType',
  'object_key as objectKey',
  'variant_8k_key as variant8kKey',
  'variant_16k_key as variant16kKey',
  'duration_ms as durationMs',
  'sha256',
  'size_bytes as sizeBytes',
  'error_message as errorMessage',
] as const;

function toAsset(row: {
  id: string;
  tenantId: string;
  kind: string;
  label: string;
  status: string;
  contentType: string;
  objectKey: string;
  variant8kKey: string | null;
  variant16kKey: string | null;
  durationMs: number | null;
  sha256: string | null;
  sizeBytes: number | null;
  errorMessage: string | null;
}): MediaAsset {
  return { ...row, kind: row.kind as MediaAssetKind, status: row.status as MediaAssetStatus };
}

/** Every raw upload lives under this prefix, one folder per asset id — keeps a tenant's uploads apart from whatever else lands in its bucket/prefix. */
const RAW_OBJECT_PREFIX = 'media-assets';

/**
 * Data access for tenant-uploaded prompts/MOH/greetings (S2-07; 05 §3.3,
 * G-5). Every query goes through `scoped(ctx)` (CLAUDE.md rule 2).
 *
 * The transcode step itself never runs here — a dedicated worker service
 * does, isolated from this service's own database and tenant secrets
 * (S2-07's own scope decision: untrusted, tenant-uploaded audio is parsed by
 * `ffmpeg` elsewhere, never in the same process/image as this service's
 * CRUD). This repo only ever hands out presigned URLs (`@cuc/storage`,
 * never touching the actual bytes) and records what the worker reports back
 * through `complete`/`fail` — both called from `internal.routes.ts`, not by
 * a real tenant actor, which is why they take a plain `{ tenantId }` context
 * rather than doing their own permission check (07 §1's established
 * internal-route precedent).
 */
export function createMediaAssetRepo(db: Database<PbxConfigServiceDb>, storage: Storage) {
  return {
    list(ctx: DbContext): Promise<MediaAsset[]> {
      return db
        .scoped(ctx)
        .selectFrom('media_assets')
        .select(COLUMNS)
        .orderBy('label', 'asc')
        .execute()
        .then((rows) => rows.map(toAsset));
    },

    findById(ctx: DbContext, id: string): Promise<MediaAsset | undefined> {
      return db
        .scoped(ctx)
        .selectFrom('media_assets')
        .select(COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : toAsset(row)));
    },

    /** Creates a `pending` row and returns a presigned PUT URL for the tenant's own client to upload the raw file directly to. */
    async create(
      ctx: DbContext,
      input: CreateMediaAssetInput,
    ): Promise<{ asset: MediaAsset; uploadUrl: string }> {
      const { tenantId } = requireTenant(ctx);
      const kind = validateKind(input.kind);
      const label = validateLabel(input.label);
      const contentType = validateContentType(input.contentType);

      const id = randomUUID();
      const objectKey = `${RAW_OBJECT_PREFIX}/${id}/raw`;
      const tenantStorage = storage.forTenant(tenantId);
      // `provisionBucket` is idempotent (`@cuc/storage`'s own doc comment) —
      // cheap to call on every create rather than tracking "have we ever
      // provisioned this tenant" ourselves. Live-verified this is not
      // optional: a presigned PUT against a bucket that was never
      // provisioned 404s as `NoSuchBucket` on the real upload, not at
      // presign time (the same gap org-service's brand-asset route had
      // until G-37 was fixed).
      await tenantStorage.provisionBucket();
      const uploadUrl = await tenantStorage.presignPut(objectKey, { contentType });

      const now = new Date();
      await db
        .scoped(ctx)
        .insertInto('media_assets')
        .values({
          id,
          kind,
          label,
          status: 'pending',
          content_type: contentType,
          object_key: objectKey,
          variant_8k_key: null,
          variant_16k_key: null,
          duration_ms: null,
          sha256: null,
          size_bytes: null,
          error_message: null,
          created_at: now,
          updated_at: now,
          version: 1,
        })
        .execute();

      return {
        asset: {
          id,
          tenantId,
          kind,
          label,
          status: 'pending',
          contentType,
          objectKey,
          variant8kKey: null,
          variant16kKey: null,
          durationMs: null,
          sha256: null,
          sizeBytes: null,
          errorMessage: null,
        },
        uploadUrl,
      };
    },

    /**
     * A presigned GET for one of a ready asset's converted WAVs, so the console can play
     * a prompt or hold music back (G-80). Only a `ready` asset has them: the raw upload is
     * never served, since it is unchecked tenant input. The URL lives for 05 §4's maximum
     * download lifetime (5 minutes).
     */
    async downloadUrl(
      ctx: DbContext,
      id: string,
      variant: MediaAssetVariant,
    ): Promise<MediaAssetDownload> {
      const { tenantId } = requireTenant(ctx);
      const asset = await db
        .scoped(ctx)
        .selectFrom('media_assets')
        .select(['status', 'variant_8k_key as variant8kKey', 'variant_16k_key as variant16kKey'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (asset === undefined) throw new MediaAssetNotFoundError(`No media asset with id '${id}'.`);
      const key = variant === '8k' ? asset.variant8kKey : asset.variant16kKey;
      if (asset.status !== 'ready' || key === null) {
        throw new InvalidMediaAssetStatusError(
          `That recording is ${asset.status}, so there is nothing to play yet.`,
        );
      }
      const url = await storage
        .forTenant(tenantId)
        .presignGet(key, { ttlSeconds: MAX_GET_TTL_SECONDS });
      return { url, expiresAt: new Date(Date.now() + MAX_GET_TTL_SECONDS * 1000) };
    },

    /**
     * The tenant confirms their upload landed — transitions `pending`
     * (or a retried `failed`) to `processing` and enqueues
     * `pbx.media_asset.finalize_requested`, the transcode worker's own
     * trigger. Thin event (06): just the id, the same "re-fetch current
     * state" story every consumer in this codebase already follows — the
     * worker calls this service's own internal API for `objectKey`/
     * `contentType` rather than trusting anything carried on the event.
     */
    async finalize(ctx: DbContext, id: string): Promise<MediaAsset> {
      const { tenantId } = requireTenant(ctx);
      let result: MediaAsset | undefined;

      await db.scoped(ctx).transaction(async (trx, raw) => {
        const existing = await trx
          .selectFrom('media_assets')
          .select(COLUMNS)
          .where('id', '=', id)
          .executeTakeFirst();
        if (existing === undefined) {
          throw new MediaAssetNotFoundError(`No media asset with id '${id}'.`);
        }
        if (existing.status !== 'pending' && existing.status !== 'failed') {
          throw new InvalidMediaAssetStatusError(
            `Cannot finalize a media asset in status '${existing.status}'.`,
          );
        }

        await trx
          .updateTable('media_assets')
          .set({ status: 'processing', error_message: null, updated_at: new Date() })
          .where('id', '=', id)
          .execute();

        await enqueueEvent(raw, pbxEvents, {
          type: 'pbx.media_asset.finalize_requested',
          data: { mediaAssetId: id },
          orgContext: { tenantId },
          ...(ctx.actorId === undefined || ctx.orgId === undefined
            ? {}
            : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });

        result = toAsset({ ...existing, status: 'processing', errorMessage: null });
      });

      return result!;
    },

    async remove(ctx: DbContext, id: string): Promise<void> {
      const result = await db
        .scoped(ctx)
        .deleteFrom('media_assets')
        .where('id', '=', id)
        .executeTakeFirst();
      if (Number(result.numDeletedRows) === 0) {
        throw new MediaAssetNotFoundError(`No media asset with id '${id}'.`);
      }
    },

    /** The transcode worker's own success callback (`internal.routes.ts`'s `:complete`). */
    async complete(ctx: DbContext, id: string, transcode: TranscodeResult): Promise<MediaAsset> {
      const existing = await db
        .scoped(ctx)
        .selectFrom('media_assets')
        .select(COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing === undefined)
        throw new MediaAssetNotFoundError(`No media asset with id '${id}'.`);

      await db
        .scoped(ctx)
        .updateTable('media_assets')
        .set({
          status: 'ready',
          duration_ms: transcode.durationMs,
          sha256: transcode.sha256,
          size_bytes: transcode.sizeBytes,
          variant_8k_key: transcode.variant8kKey,
          variant_16k_key: transcode.variant16kKey,
          error_message: null,
          updated_at: new Date(),
        })
        .where('id', '=', id)
        .execute();

      return toAsset({
        ...existing,
        status: 'ready',
        durationMs: transcode.durationMs,
        sha256: transcode.sha256,
        sizeBytes: transcode.sizeBytes,
        variant8kKey: transcode.variant8kKey,
        variant16kKey: transcode.variant16kKey,
        errorMessage: null,
      });
    },

    /** The transcode worker's own failure callback (`internal.routes.ts`'s `:fail`) — e.g. `ffmpeg` rejected the upload as not real audio. */
    async fail(ctx: DbContext, id: string, errorMessage: string): Promise<MediaAsset> {
      const existing = await db
        .scoped(ctx)
        .selectFrom('media_assets')
        .select(COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing === undefined)
        throw new MediaAssetNotFoundError(`No media asset with id '${id}'.`);

      await db
        .scoped(ctx)
        .updateTable('media_assets')
        .set({ status: 'failed', error_message: errorMessage, updated_at: new Date() })
        .where('id', '=', id)
        .execute();

      return toAsset({ ...existing, status: 'failed', errorMessage });
    },
  };
}

export type MediaAssetRepo = ReturnType<typeof createMediaAssetRepo>;
