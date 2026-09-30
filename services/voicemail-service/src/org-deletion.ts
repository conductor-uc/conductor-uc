import { scopedFor, type Database, type Transaction } from '@cuc/db';
import { createOrgDeletedConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import { voicemailEvents } from './events.js';
import type { VoicemailServiceDb } from './schema.js';

/** Removes a deleted tenant's rows, every table this service keeps for it (S1-16, G-11 (3)). */
export async function purgeTenant(
  trx: Transaction<VoicemailServiceDb>,
  tenantId: string,
): Promise<void> {
  const tenant = scopedFor(trx, { tenantId });
  await tenant.deleteFrom('messages').execute();
  await tenant.deleteFrom('mailboxes').execute();
  await tenant.deleteFrom('transcription_settings').execute();
}

/** S1-16: `org.*.deleted`, handled once per org (`voicemail-org-deleted`). */
export function createOrgDeletionConsumer(
  db: Database<VoicemailServiceDb>,
  bus: Bus,
  logger: Logger,
  options: { readonly pullTimeoutMs?: number } = {},
): EventConsumer {
  return createOrgDeletedConsumer<VoicemailServiceDb>({
    db: db.kysely,
    bus,
    logger,
    registry: voicemailEvents,
    durable: 'voicemail-service-org-deleted',
    tenant: purgeTenant,
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
  });
}
