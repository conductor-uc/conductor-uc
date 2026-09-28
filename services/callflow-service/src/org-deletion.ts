import { scopedFor, type Database, type Transaction } from '@cuc/db';
import { createOrgDeletedConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import { flowEvents } from './events.js';
import type { CallflowServiceDb } from './schema.js';

/** Removes a deleted tenant's rows, every table this service keeps for it (S1-16, G-11 (3)). */
export async function purgeTenant(
  trx: Transaction<CallflowServiceDb>,
  tenantId: string,
): Promise<void> {
  const tenant = scopedFor(trx, { tenantId });
  await tenant.deleteFrom('flow_versions').execute();
  await tenant.deleteFrom('flows').execute();
}

/** S1-16: `org.*.deleted`, handled once per org (`callflow-org-deleted`). */
export function createOrgDeletionConsumer(
  db: Database<CallflowServiceDb>,
  bus: Bus,
  logger: Logger,
  options: { readonly pullTimeoutMs?: number } = {},
): EventConsumer {
  return createOrgDeletedConsumer<CallflowServiceDb>({
    db: db.kysely,
    bus,
    logger,
    registry: flowEvents,
    durable: 'callflow-service-org-deleted',
    tenant: purgeTenant,
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
  });
}
