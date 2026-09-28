import { randomUUID } from 'node:crypto';

import { recordAuditEvent } from '@cuc/audit';
import type { Database } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import { orgEvents } from '../events.js';
import type { OrgServiceDb } from '../schema.js';

export type FileExportStatus = OrgServiceDb['file_exports']['status'];

export interface FileExport {
  readonly id: string;
  readonly tenantId: string;
  readonly status: FileExportStatus;
  readonly objectKey: string | null;
  readonly sizeBytes: number | null;
  readonly fileCount: number | null;
  readonly errorMessage: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Who asked, for the audit trail. */
export interface ExportActor {
  readonly actorId: string;
  readonly actorOrgId: string;
  readonly requestId?: string | undefined;
  readonly ip?: string | undefined;
}

type Row = OrgServiceDb['file_exports'];

function toExport(row: Row): FileExport {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    status: row.status,
    objectKey: row.object_key,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    fileCount: row.file_count,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * S1-16 (G-11 (2)): a tenant's files exports. Every table access goes through
 * `scoped` (CLAUDE.md rule 2). Asking for one and handing out its download
 * link are both audited (`data.export.requested`, `data.export.downloaded`,
 * class `private`).
 */
export function createFileExportRepo(db: Database<OrgServiceDb>) {
  return {
    async create(
      tenantId: string,
      actor: ExportActor,
      now: Date = new Date(),
    ): Promise<FileExport> {
      const row: Row = {
        id: randomUUID(),
        tenant_id: tenantId,
        status: 'pending',
        object_key: null,
        size_bytes: null,
        file_count: null,
        error_message: null,
        requested_by: actor.actorId,
        created_at: now,
        updated_at: now,
      };
      await db.scoped({ tenantId }).transaction(async (trx, raw) => {
        const { tenant_id: _tenant, ...values } = row;
        await trx.insertInto('file_exports').values(values).execute();
        await enqueueEvent(raw, orgEvents, {
          type: 'org.file_export.requested',
          data: { exportId: row.id, tenantId },
          orgContext: { tenantId },
        });
        await recordAuditEvent(raw, {
          actorType: 'user',
          actorId: actor.actorId,
          actorOrgId: actor.actorOrgId,
          targetOrgId: tenantId,
          action: 'data.export.requested',
          resource: `file_export:${row.id}`,
          dataClass: 'private',
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          ...(actor.ip === undefined ? {} : { ip: actor.ip }),
        });
      });
      return toExport(row);
    },

    async list(tenantId: string): Promise<FileExport[]> {
      const rows = await db
        .scoped({ tenantId })
        .selectFrom('file_exports')
        .selectAll()
        .orderBy('created_at', 'desc')
        .limit(20)
        .execute();
      return rows.map(toExport);
    },

    async findById(tenantId: string, id: string): Promise<FileExport | undefined> {
      const row = await db
        .scoped({ tenantId })
        .selectFrom('file_exports')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row === undefined ? undefined : toExport(row);
    },

    /** A download link is being handed out: audited like a read of the data itself. */
    async recordDownload(tenantId: string, id: string, actor: ExportActor): Promise<void> {
      await recordAuditEvent(db.kysely, {
        actorType: 'user',
        actorId: actor.actorId,
        actorOrgId: actor.actorOrgId,
        targetOrgId: tenantId,
        action: 'data.export.downloaded',
        resource: `file_export:${id}`,
        dataClass: 'private',
        ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
        ...(actor.ip === undefined ? {} : { ip: actor.ip }),
      });
    },

    async mark(
      tenantId: string,
      id: string,
      changes: {
        readonly status: FileExportStatus;
        readonly objectKey?: string;
        readonly sizeBytes?: number;
        readonly fileCount?: number;
        readonly errorMessage?: string;
      },
    ): Promise<void> {
      await db
        .scoped({ tenantId })
        .updateTable('file_exports')
        .set({
          status: changes.status,
          ...(changes.objectKey === undefined ? {} : { object_key: changes.objectKey }),
          ...(changes.sizeBytes === undefined ? {} : { size_bytes: changes.sizeBytes }),
          ...(changes.fileCount === undefined ? {} : { file_count: changes.fileCount }),
          ...(changes.errorMessage === undefined ? {} : { error_message: changes.errorMessage }),
          updated_at: new Date(),
        })
        .where('id', '=', id)
        .execute();
    },
  };
}

export type FileExportRepo = ReturnType<typeof createFileExportRepo>;
