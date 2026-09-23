import type { DbContext } from '@cuc/db';
import { ProblemError, Type, type Server } from '@cuc/http';
import type { Storage } from '@cuc/storage';

import { CDR_DIRECTIONS } from '../domain/cdr.js';
import { InvalidExportRangeError } from '../domain/export.js';
import type { CdrRepo } from '../repo/cdr.repo.js';
import type { ExportRepo } from '../repo/export.repo.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });
const CdrParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});
const CdrListQuerySchema = Type.Object({
  from: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
  direction: Type.Optional(Type.Union(CDR_DIRECTIONS.map((value) => Type.Literal(value)))),
  did: Type.Optional(Type.String()),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
});

const CdrSchema = Type.Object({
  id: Type.String(),
  direction: Type.String(),
  startAt: Type.String(),
  answerAt: Type.Union([Type.String(), Type.Null()]),
  endAt: Type.String(),
  durationSec: Type.Number(),
  billableSec: Type.Number(),
  fromNumber: Type.String(),
  fromName: Type.Union([Type.String(), Type.Null()]),
  toNumber: Type.String(),
  dialedNumber: Type.String(),
  did: Type.Union([Type.String(), Type.Null()]),
  trunkId: Type.Union([Type.String(), Type.Null()]),
  extensionIds: Type.Array(Type.String()),
  disposition: Type.String(),
  hangupCause: Type.String(),
  hangupBy: Type.String(),
  queueId: Type.Union([Type.String(), Type.Null()]),
  flowId: Type.Union([Type.String(), Type.Null()]),
  recordingIds: Type.Array(Type.String()),
});

const CreateExportBodySchema = Type.Object({
  from: Type.String({ minLength: 1 }),
  to: Type.String({ minLength: 1 }),
});
const ExportParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});
const ExportSchema = Type.Object({
  id: Type.String(),
  status: Type.String(),
  fromAt: Type.String(),
  toAt: Type.String(),
  /** Present only once `status` is `ready` — a presigned, time-limited download URL, never the raw object key. */
  downloadUrl: Type.Union([Type.String(), Type.Null()]),
  errorMessage: Type.Union([Type.String(), Type.Null()]),
});

function ctxFor(request: {
  readonly context: DbContext;
  readonly params: { readonly tenantId: string };
}): DbContext {
  return { ...request.context, tenantId: request.params.tenantId };
}

function toCdrResponse(cdr: {
  id: string;
  direction: string;
  startAt: Date;
  answerAt: Date | null;
  endAt: Date;
  durationSec: number;
  billableSec: number;
  fromNumber: string;
  fromName: string | null;
  toNumber: string;
  dialedNumber: string;
  did: string | null;
  trunkId: string | null;
  extensionIds: readonly string[];
  disposition: string;
  hangupCause: string;
  hangupBy: string;
  queueId: string | null;
  flowId: string | null;
  recordingIds: readonly string[];
}) {
  return {
    id: cdr.id,
    direction: cdr.direction,
    startAt: cdr.startAt.toISOString(),
    answerAt: cdr.answerAt === null ? null : cdr.answerAt.toISOString(),
    endAt: cdr.endAt.toISOString(),
    durationSec: cdr.durationSec,
    billableSec: cdr.billableSec,
    fromNumber: cdr.fromNumber,
    fromName: cdr.fromName,
    toNumber: cdr.toNumber,
    dialedNumber: cdr.dialedNumber,
    did: cdr.did,
    trunkId: cdr.trunkId,
    extensionIds: [...cdr.extensionIds],
    disposition: cdr.disposition,
    hangupCause: cdr.hangupCause,
    hangupBy: cdr.hangupBy,
    queueId: cdr.queueId,
    flowId: cdr.flowId,
    recordingIds: [...cdr.recordingIds],
  };
}

/**
 * Registers `/v1/tenants/{tenantId}/cdrs` and `/cdr-exports` (S2-18; 06's
 * cdr-service section). `cdr.read`/`cdr.export` are already in 07 §3.3's own
 * catalog, `private`-class — `@cuc/http` enforces H1 automatically off that
 * declaration alone (no reseller-specific check needed here, unlike
 * `billing.routes.ts`'s own `usage`-class surface).
 */
export function registerCdrRoutes(
  app: Server,
  cdrs: CdrRepo,
  exports_: ExportRepo,
  storage: Storage,
): void {
  app.get(
    '/v1/tenants/:tenantId/cdrs',
    {
      config: { permission: 'cdr.read', dataClass: 'private' },
      schema: {
        params: TenantParamsSchema,
        querystring: CdrListQuerySchema,
        response: {
          200: Type.Object({
            rows: Type.Array(CdrSchema),
            nextCursor: Type.Union([Type.String(), Type.Null()]),
          }),
        },
      },
    },
    async (request) => {
      const query = request.query;
      const page = await cdrs.list(ctxFor(request), {
        ...(query.from === undefined ? {} : { from: new Date(query.from) }),
        ...(query.to === undefined ? {} : { to: new Date(query.to) }),
        ...(query.direction === undefined ? {} : { direction: query.direction }),
        ...(query.did === undefined ? {} : { did: query.did }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
      return { rows: page.rows.map(toCdrResponse), nextCursor: page.nextCursor };
    },
  );

  app.get(
    '/v1/tenants/:tenantId/cdrs/:id',
    {
      config: { permission: 'cdr.read', dataClass: 'private' },
      schema: { params: CdrParamsSchema, response: { 200: CdrSchema } },
    },
    async (request) => {
      const found = await cdrs.findById(ctxFor(request), request.params.id);
      if (found === undefined) throw ProblemError.notFound('No CDR with that id.');
      return toCdrResponse(found);
    },
  );

  app.post(
    '/v1/tenants/:tenantId/cdr-exports',
    {
      config: { permission: 'cdr.export', dataClass: 'private' },
      schema: {
        params: TenantParamsSchema,
        body: CreateExportBodySchema,
        response: { 201: ExportSchema },
      },
    },
    async (request, reply) => {
      try {
        const created = await exports_.create(
          ctxFor(request),
          new Date(request.body.from),
          new Date(request.body.to),
        );
        return reply.status(201).send({
          id: created.id,
          status: created.status,
          fromAt: created.fromAt.toISOString(),
          toAt: created.toAt.toISOString(),
          downloadUrl: null,
          errorMessage: null,
        });
      } catch (error) {
        if (error instanceof InvalidExportRangeError) throw ProblemError.badRequest(error.message);
        throw error;
      }
    },
  );

  app.get(
    '/v1/tenants/:tenantId/cdr-exports/:id',
    {
      config: { permission: 'cdr.export', dataClass: 'private' },
      schema: { params: ExportParamsSchema, response: { 200: ExportSchema } },
    },
    async (request) => {
      const found = await exports_.findById(ctxFor(request), request.params.id);
      if (found === undefined) throw ProblemError.notFound('No CDR export with that id.');

      const downloadUrl =
        found.status === 'ready' && found.objectKey !== null
          ? await storage.forTenant(found.tenantId).presignGet(found.objectKey)
          : null;

      return {
        id: found.id,
        status: found.status,
        fromAt: found.fromAt.toISOString(),
        toAt: found.toAt.toISOString(),
        downloadUrl,
        errorMessage: found.errorMessage,
      };
    },
  );
}
