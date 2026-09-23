import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { requireTenant } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import { validateExportRange, type ExportStatus } from '../domain/export.js';
import { cdrEvents } from '../events.js';
import type { CdrServiceDb } from '../schema.js';

export interface CdrExport {
  readonly id: string;
  readonly tenantId: string;
  readonly status: ExportStatus;
  readonly fromAt: Date;
  readonly toAt: Date;
  readonly objectKey: string | null;
  readonly errorMessage: string | null;
}

export class CdrExportNotFoundError extends Error {
  override readonly name = 'CdrExportNotFoundError';
}

interface CdrExportRow {
  id: string;
  tenant_id: string;
  status: string;
  from_at: Date;
  to_at: Date;
  object_key: string | null;
  error_message: string | null;
}

function toCdrExport(row: CdrExportRow): CdrExport {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    status: row.status as ExportStatus,
    fromAt: row.from_at,
    toAt: row.to_at,
    objectKey: row.object_key,
    errorMessage: row.error_message,
  };
}

/**
 * Data access for CDR export jobs (S2-18). The actual CSV generation and S3
 * upload happen in `consumers/export.consumer.ts`, triggered by the
 * `cdr.export_requested` event `create` enqueues — this repo only owns the
 * job row's lifecycle (`pending -> processing -> ready|failed`).
 */
export function createExportRepo(db: Database<CdrServiceDb>) {
  return {
    async create(ctx: DbContext, fromAt: Date, toAt: Date): Promise<CdrExport> {
      const { tenantId } = requireTenant(ctx);
      const range = validateExportRange(fromAt, toAt);

      const id = randomUUID();
      const now = new Date();

      await db.scoped(ctx).transaction(async (trx, raw) => {
        await trx
          .insertInto('cdr_exports')
          .values({
            id,
            status: 'pending',
            from_at: range.fromAt,
            to_at: range.toAt,
            object_key: null,
            error_message: null,
            created_at: now,
            updated_at: now,
          })
          .execute();

        await enqueueEvent(raw, cdrEvents, {
          type: 'cdr.export_requested',
          data: { exportId: id, tenantId },
          orgContext: { tenantId },
        });
      });

      return {
        id,
        tenantId,
        status: 'pending',
        fromAt: range.fromAt,
        toAt: range.toAt,
        objectKey: null,
        errorMessage: null,
      };
    },

    findById(ctx: DbContext, id: string): Promise<CdrExport | undefined> {
      return db
        .scoped(ctx)
        .selectFrom('cdr_exports')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : toCdrExport(row)));
    },

    /** Cross-tenant — the export consumer looks a job up by id alone, before it knows which tenant to scope to. */
    findByIdUnscoped(id: string): Promise<CdrExport | undefined> {
      return db.kysely
        .selectFrom('cdr_exports')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : toCdrExport(row)));
    },

    async markProcessing(id: string): Promise<void> {
      const result = await db.kysely
        .updateTable('cdr_exports')
        .set({ status: 'processing', updated_at: new Date() })
        .where('id', '=', id)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        throw new CdrExportNotFoundError(`No CDR export with id '${id}'.`);
      }
    },

    async markReady(id: string, objectKey: string): Promise<void> {
      const result = await db.kysely
        .updateTable('cdr_exports')
        .set({ status: 'ready', object_key: objectKey, updated_at: new Date() })
        .where('id', '=', id)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        throw new CdrExportNotFoundError(`No CDR export with id '${id}'.`);
      }
    },

    async markFailed(id: string, errorMessage: string): Promise<void> {
      const result = await db.kysely
        .updateTable('cdr_exports')
        .set({ status: 'failed', error_message: errorMessage, updated_at: new Date() })
        .where('id', '=', id)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        throw new CdrExportNotFoundError(`No CDR export with id '${id}'.`);
      }
    },
  };
}

export type ExportRepo = ReturnType<typeof createExportRepo>;
