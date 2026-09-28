import { scopedFor, type Database, type Transaction } from '@cuc/db';
import { createOrgDeletedConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import { pbxEvents } from './events.js';
import type { PbxConfigServiceDb } from './schema.js';

/**
 * Removes a deleted tenant's PBX configuration, every table this service keeps
 * for it, dependents first (S1-16, G-11 (3)). Its stored media (prompts, hold
 * music, greetings) goes with the tenant's bucket, which org-service purges.
 */
export async function purgeTenant(
  trx: Transaction<PbxConfigServiceDb>,
  tenantId: string,
): Promise<void> {
  const tenant = scopedFor(trx, { tenantId });
  for (const table of [
    'queue_tiers',
    'agents',
    'queues',
    'pickup_groups',
    'ring_groups',
    'parking_lots',
    'conference_rooms',
    'extension_call_handling',
    'devices',
    'sip_credentials',
    'dids',
    'extensions',
    'emergency_locations',
    'schedules',
    'media_assets',
  ] as const) {
    await tenant.deleteFrom(table).execute();
  }
}

/** S1-16: `org.tenant.deleted`, handled once per tenant (`pbx-config-service-org-deleted`). */
export function createOrgDeletionConsumer(
  db: Database<PbxConfigServiceDb>,
  bus: Bus,
  logger: Logger,
  options: { readonly pullTimeoutMs?: number } = {},
): EventConsumer {
  return createOrgDeletedConsumer<PbxConfigServiceDb>({
    db: db.kysely,
    bus,
    logger,
    registry: pbxEvents,
    durable: 'pbx-config-service-org-deleted',
    tenant: purgeTenant,
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
  });
}
