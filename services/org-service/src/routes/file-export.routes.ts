import { clientIpOf, ProblemError, Type, type Server } from '@cuc/http';
import type { Storage } from '@cuc/storage';

import type { ExportActor, FileExport, FileExportRepo } from '../repo/file-export.repo.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });
const ExportParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});

const FileExportSchema = Type.Object({
  id: Type.String(),
  status: Type.Union([
    Type.Literal('pending'),
    Type.Literal('processing'),
    Type.Literal('ready'),
    Type.Literal('failed'),
  ]),
  fileCount: Type.Union([Type.Integer(), Type.Null()]),
  sizeBytes: Type.Union([Type.Integer(), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
  /** Only on a single ready export, and only for a few minutes. */
  downloadUrl: Type.Union([Type.String(), Type.Null()]),
  errorMessage: Type.Union([Type.String(), Type.Null()]),
});

function view(job: FileExport, downloadUrl: string | null = null) {
  return {
    id: job.id,
    status: job.status,
    fileCount: job.fileCount,
    sizeBytes: job.sizeBytes,
    createdAt: job.createdAt.toISOString(),
    downloadUrl,
    errorMessage: job.errorMessage,
  };
}

/**
 * `/v1/tenants/{tenantId}/file-exports` (S1-16, G-11 (2)): a zip of the
 * tenant's recordings and voicemail, above all before it is deleted.
 * `data.export`, class `private`: a tenant's own administrator or the master,
 * never a reseller (H1). Built in the background (202, then `pending`,
 * `processing`, `ready` or `failed`); can be built again as often as needed.
 * A single export's `downloadUrl` is a short-lived link, and handing one out
 * is audited (`data.export.downloaded`), as asking for the build is
 * (`data.export.requested`).
 */
export function registerFileExportRoutes(
  app: Server,
  deps: { readonly exports: FileExportRepo; readonly storage: Storage },
): void {
  const { exports, storage } = deps;
  const config = { permission: 'data.export', dataClass: 'private' } as const;

  function actorOf(request: Parameters<typeof clientIpOf>[0]): ExportActor {
    const { actorId, actorType, orgId, requestId } = request.context;
    if (actorId === undefined || orgId === undefined || actorType !== 'user') {
      throw ProblemError.forbidden('Only a signed-in person can export data.', {
        code: 'people_only',
      });
    }
    const ip = clientIpOf(request);
    return { actorId, actorOrgId: orgId, requestId, ...(ip === '' ? {} : { ip }) };
  }

  app.post(
    '/v1/tenants/:tenantId/file-exports',
    {
      config,
      schema: { params: TenantParamsSchema, response: { 202: FileExportSchema } },
    },
    async (request, reply) => {
      const created = await exports.create(request.params.tenantId, actorOf(request));
      return reply.status(202).send(view(created));
    },
  );

  app.get(
    '/v1/tenants/:tenantId/file-exports',
    {
      config,
      schema: {
        params: TenantParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(FileExportSchema) }) },
      },
    },
    async (request) => ({
      rows: (await exports.list(request.params.tenantId)).map((job) => view(job)),
    }),
  );

  app.get(
    '/v1/tenants/:tenantId/file-exports/:id',
    {
      config,
      schema: { params: ExportParamsSchema, response: { 200: FileExportSchema } },
    },
    async (request) => {
      const { tenantId, id } = request.params;
      const job = await exports.findById(tenantId, id);
      if (job === undefined) {
        throw ProblemError.notFound('No such export.', { code: 'export_not_found' });
      }
      if (job.status !== 'ready' || job.objectKey === null) return view(job);
      const actor = actorOf(request);
      await exports.recordDownload(tenantId, id, actor);
      const url = await storage.forTenant(tenantId).presignGet(job.objectKey, {
        ttlSeconds: 300,
        responseContentDisposition: 'attachment; filename="recordings-and-voicemail.zip"',
      });
      return view(job, url);
    },
  );
}
