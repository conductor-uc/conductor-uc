import { scopedFor, type Database, type Transaction } from '@cuc/db';
import { createOrgDeletedConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import { cdrEvents } from './events.js';
import type { CdrServiceDb } from './schema.js';

/** Removes a deleted tenant's rows, every table this service keeps for it (S1-16, G-11 (3)). */
export async function purgeTenant(trx: Transaction<CdrServiceDb>, tenantId: string): Promise<void> {
  const tenant = scopedFor(trx, { tenantId });
  await tenant.deleteFrom('cdr_exports').execute();
  await tenant.deleteFrom('cdrs').execute();
}

/** S1-16: `org.*.deleted`, handled once per org (`cdr-org-deleted`). */
export function createOrgDeletionConsumer(
  db: Database<CdrServiceDb>,
  bus: Bus,
  logger: Logger,
  options: { readonly pullTimeoutMs?: number } = {},
): EventConsumer {
  return createOrgDeletedConsumer<CdrServiceDb>({
    db: db.kysely,
    bus,
    logger,
    registry: cdrEvents,
    durable: 'cdr-service-org-deleted',
    tenant: purgeTenant,
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
  });
}
