import type { Database } from '@cuc/db';
import { createConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';
import type { Storage } from '@cuc/storage';

import { toCsv } from '../domain/export.js';
import { cdrEvents } from '../events.js';
import type { CdrRepo } from '../repo/cdr.repo.js';
import type { ExportRepo } from '../repo/export.repo.js';
import type { CdrServiceDb } from '../schema.js';

interface ExportRequestedData {
  readonly exportId: string;
  readonly tenantId: string;
}

export interface ExportConsumerOptions {
  /** How long one pull waits for a message (`@cuc/events`' default: 1s). Longer in tests. */
  readonly pullTimeoutMs?: number;
}

function objectKeyFor(tenantId: string, exportId: string): string {
  return `cdr-exports/${tenantId}/${exportId}.csv`;
}

/**
 * The `CDR` stream consumer for `cdr.export_requested` (S2-18) — this
 * service both publishes and consumes it (`repo/export.repo.ts`'s own doc
 * comment on why), the same "outbox decouples the HTTP response from the
 * actual work" pattern `media-asset.consumer.ts` establishes for a
 * cross-service trigger, applied here within one service instead.
 *
 * Walks every matching CDR (`cdr.repo.ts`'s `listAllInRange`, paging
 * internally), serializes the `private`-class columns only (`domain/
 * export.ts`'s `toCsv` — `legs`/`sip` never leave as a spreadsheet column),
 * and writes the result to this tenant's own bucket. A failure here is
 * reported through `:markFailed` and the handler returns normally (acked,
 * not retried) for a data problem a redelivery cannot fix on its own — the
 * tenant re-requests the export instead, the same "permanent failure is
 * reported, not retried" precedent `media-asset.consumer.ts`'s own
 * `TranscodeError` branch sets.
 */
export function createExportConsumer(
  db: Database<CdrServiceDb>,
  bus: Bus,
  logger: Logger,
  storage: Storage,
  cdrRepo: CdrRepo,
  exportRepo: ExportRepo,
  options: ExportConsumerOptions = {},
): EventConsumer {
  return createConsumer<CdrServiceDb>({
    db: db.kysely,
    bus,
    logger,
    registry: cdrEvents,
    durable: 'cdr-service-export',
    subjects: ['cdr.export_requested'],
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
    handler: async (envelope) => {
      const { exportId, tenantId } = envelope.data as ExportRequestedData;
      const log = logger.child({ tenantId, exportId });

      const job = await exportRepo.findByIdUnscoped(exportId);
      if (job === undefined) {
        log.warn('export job not found; skipping');
        return;
      }

      await exportRepo.markProcessing(exportId);

      let csv: string;
      try {
        const rows = await cdrRepo.listAllInRange(tenantId, job.fromAt, job.toAt);
        csv = toCsv(rows);
      } catch (error) {
        log.error({ err: error }, 'failed to build the CDR export; reporting failure');
        await exportRepo.markFailed(
          exportId,
          `export failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }

      const objectKey = objectKeyFor(tenantId, exportId);
      const tenantStorage = storage.forTenant(tenantId);
      // Idempotent (`@cuc/storage`'s own doc comment) — nothing else
      // provisions this tenant's bucket before an export is the first
      // thing it ever writes, unlike voicemail's own mailbox creation or
      // pbx-config-service's media-asset upload flow.
      await tenantStorage.provisionBucket();
      await tenantStorage.putObject(objectKey, Buffer.from(csv, 'utf8'), {
        contentType: 'text/csv',
      });
      await exportRepo.markReady(exportId, objectKey);
      log.info('CDR export ready');
    },
  });
}
