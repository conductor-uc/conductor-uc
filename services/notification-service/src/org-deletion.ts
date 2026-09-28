import type { Database, Transaction } from '@cuc/db';
import { createOrgDeletedConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import { notificationEvents } from './events.js';
import type { NotificationServiceDb } from './schema.js';

/**
 * Removes the emails sent for a deleted org (S1-16, G-11 (3)). `sent_emails` is
 * keyed by `org_id`, a tenant or a reseller, so it is not a tenant-owned table
 * and the org is named explicitly.
 */
export async function purgeOrg(
  trx: Transaction<NotificationServiceDb>,
  orgId: string,
): Promise<void> {
  await trx.deleteFrom('sent_emails').where('org_id', '=', orgId).execute();
}

/** S1-16: `org.*.deleted`, handled once per org (`notification-org-deleted`). */
export function createOrgDeletionConsumer(
  db: Database<NotificationServiceDb>,
  bus: Bus,
  logger: Logger,
  options: { readonly pullTimeoutMs?: number } = {},
): EventConsumer {
  return createOrgDeletedConsumer<NotificationServiceDb>({
    db: db.kysely,
    bus,
    logger,
    registry: notificationEvents,
    durable: 'notification-service-org-deleted',
    tenant: purgeOrg,
    reseller: purgeOrg,
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
  });
}
