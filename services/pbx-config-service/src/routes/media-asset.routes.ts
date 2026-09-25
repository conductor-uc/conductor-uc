import type { DbContext } from '@cuc/db';
import { ProblemError, Type, type Server, type Static } from '@cuc/http';

import { InvalidMediaAssetError } from '../domain/media-asset.js';
import {
  InvalidMediaAssetStatusError,
  MediaAssetNotFoundError,
  type MediaAssetRepo,
} from '../repo/media-asset.repo.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });
const AssetParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});

const MediaAssetSchema = Type.Object({
  id: Type.String(),
  kind: Type.Union([Type.Literal('prompt'), Type.Literal('moh'), Type.Literal('greeting')]),
  label: Type.String(),
  status: Type.Union([
    Type.Literal('pending'),
    Type.Literal('processing'),
    Type.Literal('ready'),
    Type.Literal('failed'),
  ]),
  contentType: Type.String(),
  durationMs: Type.Union([Type.Number(), Type.Null()]),
  sha256: Type.Union([Type.String(), Type.Null()]),
  sizeBytes: Type.Union([Type.Number(), Type.Null()]),
  errorMessage: Type.Union([Type.String(), Type.Null()]),
});
type MediaAssetResponse = Static<typeof MediaAssetSchema>;

const DownloadQuerySchema = Type.Object({
  /** Which converted copy to play. Defaults to 16 kHz, the better of the two. */
  variant: Type.Optional(Type.Union([Type.Literal('16k'), Type.Literal('8k')])),
});

const DownloadUrlSchema = Type.Object({ url: Type.String(), expiresAt: Type.String() });

const CreateMediaAssetBodySchema = Type.Object({
  kind: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
  contentType: Type.String({ minLength: 1 }),
});

function toResponse(asset: {
  id: string;
  kind: string;
  label: string;
  status: string;
  contentType: string;
  durationMs: number | null;
  sha256: string | null;
  sizeBytes: number | null;
  errorMessage: string | null;
}): MediaAssetResponse {
  return asset as MediaAssetResponse;
}

function ctxFor(request: {
  readonly context: DbContext;
  readonly params: { readonly tenantId: string };
}): DbContext {
  return { ...request.context, tenantId: request.params.tenantId };
}

function toProblem(error: unknown): ProblemError {
  if (error instanceof InvalidMediaAssetError) return ProblemError.badRequest(error.message);
  if (error instanceof MediaAssetNotFoundError) return ProblemError.notFound(error.message);
  if (error instanceof InvalidMediaAssetStatusError) {
    return ProblemError.conflict(error.message, { code: 'invalid_media_asset_status' });
  }
  throw error;
}

/**
 * Registers `/v1/tenants/{tenantId}/media-assets` (S2-07; 05 §3.3, G-5).
 * `POST` only ever creates the *row* plus a presigned PUT URL — the caller
 * does the actual upload directly against S3, not through this service
 * (05 §4's own "presigned URLs only" rule). `:finalize` is the tenant's own
 * confirmation that the upload landed; transcoding itself happens
 * elsewhere (`internal.routes.ts`'s own doc comment on why).
 */
export function registerMediaAssetRoutes(app: Server, assets: MediaAssetRepo): void {
  app.get(
    '/v1/tenants/:tenantId/media-assets',
    {
      config: { permission: 'media.read', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(MediaAssetSchema) }) },
      },
    },
    async (request) => ({ rows: (await assets.list(ctxFor(request))).map(toResponse) }),
  );

  app.get(
    '/v1/tenants/:tenantId/media-assets/:id',
    {
      config: { permission: 'media.read', dataClass: 'config' },
      schema: { params: AssetParamsSchema, response: { 200: MediaAssetSchema } },
    },
    async (request) => {
      const found = await assets.findById(ctxFor(request), request.params.id);
      if (found === undefined) throw ProblemError.notFound('No media asset with that id.');
      return toResponse(found);
    },
  );

  // A short-lived address to play a ready asset's converted audio from (G-80). The
  // console opens it in a new tab, where the browser plays the WAV.
  app.get(
    '/v1/tenants/:tenantId/media-assets/:id/download-url',
    {
      config: { permission: 'media.read', dataClass: 'config' },
      schema: {
        params: AssetParamsSchema,
        querystring: DownloadQuerySchema,
        response: { 200: DownloadUrlSchema },
      },
    },
    async (request) => {
      try {
        const { url, expiresAt } = await assets.downloadUrl(
          ctxFor(request),
          request.params.id,
          request.query.variant ?? '16k',
        );
        return { url, expiresAt: expiresAt.toISOString() };
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.post(
    '/v1/tenants/:tenantId/media-assets',
    {
      config: { permission: 'media.manage', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        body: CreateMediaAssetBodySchema,
        response: { 201: Type.Object({ asset: MediaAssetSchema, uploadUrl: Type.String() }) },
      },
    },
    async (request, reply) => {
      try {
        const { asset, uploadUrl } = await assets.create(ctxFor(request), request.body);
        return reply.status(201).send({ asset: toResponse(asset), uploadUrl });
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.post(
    '/v1/tenants/:tenantId/media-assets/:id/finalize',
    {
      config: { permission: 'media.manage', dataClass: 'config' },
      schema: { params: AssetParamsSchema, response: { 200: MediaAssetSchema } },
    },
    async (request) => {
      try {
        return toResponse(await assets.finalize(ctxFor(request), request.params.id));
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/media-assets/:id',
    {
      config: { permission: 'media.manage', dataClass: 'config' },
      schema: { params: AssetParamsSchema },
    },
    async (request, reply) => {
      try {
        await assets.remove(ctxFor(request), request.params.id);
      } catch (error) {
        throw toProblem(error);
      }
      return reply.status(204).send();
    },
  );
}
