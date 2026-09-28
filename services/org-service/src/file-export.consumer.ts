import { PassThrough } from 'node:stream';

import archiver from 'archiver';
import type { Database } from '@cuc/db';
import { createConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';
import type { Storage } from '@cuc/storage';

import { orgEvents } from './events.js';
import type { FileExportRepo } from './repo/file-export.repo.js';
import type { OrgServiceDb } from './schema.js';

/** What goes in the zip: every recording, and every voicemail message and greeting. */
const EXPORTED_PREFIXES = ['recordings/', 'voicemail/'] as const;

export function fileExportKey(exportId: string): string {
  return `exports/files-${exportId}.zip`;
}

/**
 * S1-16 (G-11 (2)): builds a tenant's files export, a zip of its recordings
 * and voicemail with the folders they are stored in. Each file is streamed
 * from storage into the zip one at a time, and the zip is uploaded in parts
 * as it is written, so neither the files nor the zip are ever held in memory.
 * The zip goes in the tenant's own storage, so it is purged with the tenant.
 */
export function createFileExportConsumer(
  db: Database<OrgServiceDb>,
  bus: Bus,
  logger: Logger,
  storage: Storage,
  exports: FileExportRepo,
  options: { readonly pullTimeoutMs?: number } = {},
): EventConsumer {
  return createConsumer<OrgServiceDb>({
    db: db.kysely,
    bus,
    logger,
    registry: orgEvents,
    durable: 'org-service-file-export',
    subjects: ['org.file_export.requested'],
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
    handler: async (envelope) => {
      const { exportId, tenantId } = envelope.data as { exportId: string; tenantId: string };
      const log = logger.child({ tenantId, exportId });
      const job = await exports.findById(tenantId, exportId);
      if (job === undefined || job.status === 'ready') return;
      await exports.mark(tenantId, exportId, { status: 'processing' });

      const tenant = storage.forTenant(tenantId);
      const key = fileExportKey(exportId);
      try {
        const zip = archiver('zip', { zlib: { level: 1 } });
        const out = new PassThrough();
        let sizeBytes = 0;
        out.on('data', (chunk: Buffer) => {
          sizeBytes += chunk.length;
        });
        zip.pipe(out);
        await tenant.provisionBucket();
        const uploaded = tenant.putStream(key, out, { contentType: 'application/zip' });

        let files = 0;
        for (const prefix of EXPORTED_PREFIXES) {
          for await (const object of tenant.list(prefix)) {
            const body = await tenant.getStream(object.key);
            // One file at a time: the next is not opened until this one is in the zip.
            await new Promise<void>((resolve, reject) => {
              zip.once('entry', () => resolve());
              zip.once('error', reject);
              zip.append(body, { name: object.key });
            });
            files += 1;
          }
        }
        await zip.finalize();
        await uploaded;
        await exports.mark(tenantId, exportId, {
          status: 'ready',
          objectKey: key,
          sizeBytes,
          fileCount: files,
        });
        log.info({ files, sizeBytes }, 'files export ready');
      } catch (error) {
        log.error({ err: error }, 'files export failed');
        await exports.mark(tenantId, exportId, {
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
}
