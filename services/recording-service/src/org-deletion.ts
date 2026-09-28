import { scopedFor, type Database, type Transaction } from '@cuc/db';
import { createOrgDeletedConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import { recordingEvents } from './events.js';
import type { RecordingServiceDb } from './schema.js';

/** Removes a deleted tenant's rows, every table this service keeps for it (S1-16, G-11 (3)). */
export async function purgeTenant(
  trx: Transaction<RecordingServiceDb>,
  tenantId: string,
): Promise<void> {
  const tenant = scopedFor(trx, { tenantId });
  await tenant.deleteFrom('recordings').execute();
  await tenant.deleteFrom('recording_policies').execute();
  await tenant.deleteFrom('recording_settings').execute();
}

/** S1-16: `org.*.deleted`, handled once per org (`recording-org-deleted`). */
export function createOrgDeletionConsumer(
  db: Database<RecordingServiceDb>,
  bus: Bus,
  logger: Logger,
  options: { readonly pullTimeoutMs?: number } = {},
): EventConsumer {
  return createOrgDeletedConsumer<RecordingServiceDb>({
    db: db.kysely,
    bus,
    logger,
    registry: recordingEvents,
    durable: 'recording-service-org-deleted',
    tenant: purgeTenant,
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
  });
}
