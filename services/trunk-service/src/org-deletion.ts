import { scopedFor, type Database, type Transaction } from '@cuc/db';
import { createOrgDeletedConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import { trunkEvents } from './events.js';
import type { TrunkServiceDb } from './schema.js';

/** Removes a deleted tenant's rows, every table this service keeps for it (S1-16, G-11 (3)). */
export async function purgeTenant(
  trx: Transaction<TrunkServiceDb>,
  tenantId: string,
): Promise<void> {
  const tenant = scopedFor(trx, { tenantId });
  await tenant.deleteFrom('outbound_routes').execute();
  await tenant.deleteFrom('emergency_routes').execute();
  await tenant.deleteFrom('trunk_ips').execute();
  await tenant.deleteFrom('trunks').execute();
}

/** S1-16: `org.*.deleted`, handled once per org (`trunk-org-deleted`). */
export function createOrgDeletionConsumer(
  db: Database<TrunkServiceDb>,
  bus: Bus,
  logger: Logger,
  options: { readonly pullTimeoutMs?: number } = {},
): EventConsumer {
  return createOrgDeletedConsumer<TrunkServiceDb>({
    db: db.kysely,
    bus,
    logger,
    registry: trunkEvents,
    durable: 'trunk-service-org-deleted',
    tenant: purgeTenant,
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
  });
}
