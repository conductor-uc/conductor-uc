import type { DbContext } from '@cuc/db';
import { ProblemError, Type, type RequestContext, type Server, type Static } from '@cuc/http';
import type { Logger } from '@cuc/logger';
import { MAX_GET_TTL_SECONDS, type Storage } from '@cuc/storage';

import type { AccessClient } from '../access.js';
import {
  auditFor,
  canForRecording,
  forbidden,
  resolveCaller,
  visibilityFor,
  type AuditSink,
  type Caller,
} from '../authorize.js';
import { downloadFileName } from '../domain/recording.js';
import {
  InvalidCursorError,
  RecordingNotFoundError,
  type Recording,
  type RecordingRepo,
} from '../repo/recording.repo.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });
const RecordingParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});

const DirectionSchema = Type.Union([
  Type.Literal('inbound'),
  Type.Literal('outbound'),
  Type.Literal('internal'),
]);
const StatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('ready'),
  Type.Literal('failed'),
  Type.Literal('expired'),
]);

const ListQuerySchema = Type.Object({
  from: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
  direction: Type.Optional(DirectionSchema),
  extensionId: Type.Optional(Type.String({ minLength: 1 })),
  queueId: Type.Optional(Type.String({ minLength: 1 })),
  didId: Type.Optional(Type.String({ minLength: 1 })),
  callUuid: Type.Optional(Type.String({ minLength: 1 })),
  status: Type.Optional(StatusSchema),
  cursor: Type.Optional(Type.String()),
  /** Query strings are not coerced, so this is text; parsed and range-checked below. */
  limit: Type.Optional(Type.String({ pattern: '^[0-9]{1,4}$' })),
});

const RecordingSchema = Type.Object({
  id: Type.String(),
  callUuid: Type.String(),
  direction: Type.String(),
  extensionId: Type.Union([Type.String(), Type.Null()]),
  peerExtensionId: Type.Union([Type.String(), Type.Null()]),
  queueId: Type.Union([Type.String(), Type.Null()]),
  didId: Type.Union([Type.String(), Type.Null()]),
  announced: Type.Boolean(),
  status: Type.String(),
  startedAt: Type.String(),
  durationMs: Type.Union([Type.Number(), Type.Null()]),
  sizeBytes: Type.Union([Type.Number(), Type.Null()]),
  retentionDate: Type.Union([Type.String(), Type.Null()]),
});
const UrlSchema = Type.Object({ url: Type.String(), expiresAt: Type.String() });

function ctxFor(request: {
  readonly context: DbContext;
  readonly params: { readonly tenantId: string };
}): DbContext {
  return { ...request.context, tenantId: request.params.tenantId };
}

function toResponse(recording: Recording): Static<typeof RecordingSchema> {
  return {
    id: recording.id,
    callUuid: recording.callUuid,
    direction: recording.direction,
    extensionId: recording.extensionId,
    peerExtensionId: recording.peerExtensionId,
    queueId: recording.queueId,
    didId: recording.didId,
    announced: recording.announced,
    status: recording.status,
    startedAt: recording.startedAt.toISOString(),
    durationMs: recording.durationMs,
    sizeBytes: recording.sizeBytes,
    retentionDate: recording.retentionDate === null ? null : recording.retentionDate.toISOString(),
  };
}

function parseDate(value: string | undefined, name: string): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw ProblemError.badRequest(`'${name}' is not a valid date.`);
  return parsed;
}

export interface RecordingRoutesDeps {
  readonly recordings: RecordingRepo;
  readonly access: AccessClient;
  readonly storage: Storage;
  readonly audit: AuditSink;
  readonly logger: Logger;
}

/**
 * `/v1/tenants/{t}/recordings` (S5-04; 06's recording-service public API). Private-class data
 * (07 §3.2): `@cuc/http` turns a reseller away before any handler here runs (H1), and each
 * handler then evaluates the caller's roles and grants per recording (`authorize.ts`), so a
 * supervisor holding `recording.listen` on `queue:Q1` lists and plays Q1's recordings only.
 *
 * Every playback or download URL is audited *before* it is issued, and a failed audit means no
 * URL: nothing leaves this service unrecorded. Deletion is audited in the same transaction as
 * the deletion. Listing and reading metadata are audited best-effort (07 §4: private reads).
 */
export function registerRecordingRoutes(app: Server, deps: RecordingRoutesDeps): void {
  const { recordings, access, storage, audit, logger } = deps;

  function caller(request: {
    readonly context: RequestContext;
    readonly params: { readonly tenantId: string };
    readonly ip: string;
  }): Promise<Caller> {
    return resolveCaller(request.context, request.params.tenantId, request.ip, access);
  }

  async function auditBestEffort(who: Caller, action: string, resource: string): Promise<void> {
    try {
      await audit(auditFor(who, { action, resource, dataClass: 'private' }));
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error), action },
        'could not publish an audit event for a recording read',
      );
    }
  }

  async function auditStrict(who: Caller, action: string, resource: string): Promise<void> {
    try {
      await audit(auditFor(who, { action, resource, dataClass: 'private' }));
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error), action },
        'audit publish failed; refusing the request',
      );
      throw new ProblemError(
        503,
        '/problems/unavailable',
        'Service unavailable',
        'audit_unavailable',
        { detail: 'The action could not be recorded, so it was not done. Try again shortly.' },
      );
    }
  }

  async function loadAuthorized(
    who: Caller,
    ctx: DbContext,
    id: string,
    permission: string,
  ): Promise<Recording> {
    const recording = await recordings.findById(ctx, id);
    if (recording === undefined) throw ProblemError.notFound('No recording with that id.');
    if (!canForRecording(who, permission, recording)) throw forbidden(permission);
    return recording;
  }

  app.get(
    '/v1/tenants/:tenantId/recordings',
    {
      config: { permission: 'recording.listen', dataClass: 'private' },
      schema: {
        params: TenantParamsSchema,
        querystring: ListQuerySchema,
        response: {
          200: Type.Object({
            rows: Type.Array(RecordingSchema),
            nextCursor: Type.Union([Type.String(), Type.Null()]),
          }),
        },
      },
    },
    async (request) => {
      const who = await caller(request);
      const visibility = visibilityFor(who, [
        'recording.listen',
        'recording.download',
        'recording.delete',
      ]);
      if (visibility === undefined) throw forbidden('recording.listen');

      const query = request.query;
      const limit = query.limit === undefined ? undefined : Number(query.limit);
      if (limit !== undefined && (limit < 1 || limit > 200)) {
        throw ProblemError.badRequest("'limit' must be between 1 and 200.");
      }
      let page;
      try {
        page = await recordings.list(ctxFor(request), {
          from: parseDate(query.from, 'from'),
          to: parseDate(query.to, 'to'),
          direction: query.direction,
          extensionId: query.extensionId,
          queueId: query.queueId,
          didId: query.didId,
          callUuid: query.callUuid,
          status: query.status,
          cursor: query.cursor,
          limit,
          visibleScopes:
            visibility.kind === 'all'
              ? undefined
              : visibility.scopes.map((scope) => ({
                  type: scope.type as 'extension' | 'queue' | 'did',
                  id: scope.id,
                })),
        });
      } catch (error) {
        if (error instanceof InvalidCursorError) throw ProblemError.badRequest(error.message);
        throw error;
      }
      await auditBestEffort(who, 'recording.listed', `tenant:${request.params.tenantId}`);
      return { rows: page.rows.map(toResponse), nextCursor: page.nextCursor };
    },
  );

  app.get(
    '/v1/tenants/:tenantId/recordings/:id',
    {
      config: { permission: 'recording.listen', dataClass: 'private' },
      schema: { params: RecordingParamsSchema, response: { 200: RecordingSchema } },
    },
    async (request) => {
      const who = await caller(request);
      const ctx = ctxFor(request);
      const recording = await recordings.findById(ctx, request.params.id);
      if (recording === undefined) throw ProblemError.notFound('No recording with that id.');
      const permitted = (
        ['recording.listen', 'recording.download', 'recording.delete'] as const
      ).some((permission) => canForRecording(who, permission, recording));
      if (!permitted) throw forbidden('recording.listen');
      await auditBestEffort(who, 'recording.read', `recording:${recording.id}`);
      return toResponse(recording);
    },
  );

  async function issueUrl(
    request: Parameters<typeof caller>[0] & { readonly params: { readonly id: string } },
    permission: 'recording.listen' | 'recording.download',
    action: string,
    download: boolean,
  ): Promise<Static<typeof UrlSchema>> {
    const who = await caller(request);
    const recording = await loadAuthorized(who, ctxFor(request), request.params.id, permission);
    if (recording.status !== 'ready') {
      throw ProblemError.conflict(
        `That recording is ${recording.status}, so it has no audio to serve.`,
        {
          code: 'recording_unavailable',
        },
      );
    }
    await auditStrict(who, action, `recording:${recording.id}`);

    const url = await storage.forTenant(request.params.tenantId).presignGet(recording.objectKey, {
      ttlSeconds: MAX_GET_TTL_SECONDS,
      ...(download
        ? { responseContentDisposition: `attachment; filename="${downloadFileName(recording.id)}"` }
        : {}),
    });
    return { url, expiresAt: new Date(Date.now() + MAX_GET_TTL_SECONDS * 1000).toISOString() };
  }

  app.get(
    '/v1/tenants/:tenantId/recordings/:id/play-url',
    {
      config: { permission: 'recording.listen', dataClass: 'private' },
      schema: { params: RecordingParamsSchema, response: { 200: UrlSchema } },
    },
    (request) => issueUrl(request, 'recording.listen', 'recording.play_url_issued', false),
  );

  app.get(
    '/v1/tenants/:tenantId/recordings/:id/download-url',
    {
      config: { permission: 'recording.download', dataClass: 'private' },
      schema: { params: RecordingParamsSchema, response: { 200: UrlSchema } },
    },
    (request) => issueUrl(request, 'recording.download', 'recording.download_url_issued', true),
  );

  app.delete(
    '/v1/tenants/:tenantId/recordings/:id',
    {
      config: { permission: 'recording.delete', dataClass: 'private' },
      schema: { params: RecordingParamsSchema },
    },
    async (request, reply) => {
      const who = await caller(request);
      const ctx = ctxFor(request);
      const recording = await loadAuthorized(who, ctx, request.params.id, 'recording.delete');

      // Audio first, then the row and its audit record together: a failure between the two
      // leaves a row whose audio is gone, and the delete can simply be repeated.
      await storage.forTenant(request.params.tenantId).deleteObject(recording.objectKey);
      try {
        await recordings.remove(
          ctx,
          recording.id,
          auditFor(who, {
            action: 'recording.deleted',
            resource: `recording:${recording.id}`,
            dataClass: 'private',
          }),
        );
      } catch (error) {
        if (error instanceof RecordingNotFoundError) throw ProblemError.notFound(error.message);
        throw error;
      }
      return reply.status(204).send();
    },
  );
}
