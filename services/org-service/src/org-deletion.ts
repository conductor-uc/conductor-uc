import { defineEvents } from '@cuc/api-contracts';
import type { Database, Transaction } from '@cuc/db';
import {
  createOrgDeletedConsumer,
  ORG_DELETED_EVENTS,
  type Bus,
  type EventConsumer,
} from '@cuc/events';
import type { Logger } from '@cuc/logger';
import type { Storage } from '@cuc/storage';

import type { OrgServiceDb } from './schema.js';

/** Just the deletions this service consumes of its own events. */
const deletionEvents = defineEvents({ ...ORG_DELETED_EVENTS });

/**
 * S1-16 (G-11 (3)): what org-service removes once an org is deleted.
 *
 * - A tenant: **everything it stored**, whichever service wrote it (its
 *   bucket, or its prefix of the shared one, is shared by every service, so
 *   it is purged once, here), and its domains. Objects go first: if that
 *   fails, the event is redelivered and nothing is half done in the database.
 * - A reseller (which has no tenants by then): its brand and its brand's
 *   files, its base domains, console hostnames and certificates.
 *
 * The org's own row stays, `deleted`, as a tombstone for its slug (02 §3).
 */
export function createOrgDeletionConsumer(
  db: Database<OrgServiceDb>,
  bus: Bus,
  logger: Logger,
  storage: Storage,
  options: { readonly pullTimeoutMs?: number } = {},
): EventConsumer {
  return createOrgDeletedConsumer<OrgServiceDb>({
    db: db.kysely,
    bus,
    logger,
    registry: deletionEvents,
    durable: 'org-service-org-deleted',
    tenant: async (trx: Transaction<OrgServiceDb>, tenantId: string) => {
      await storage.purgeTenant(tenantId);
      await trx.deleteFrom('tenant_domains').where('tenant_id', '=', tenantId).execute();
    },
    reseller: async (trx: Transaction<OrgServiceDb>, resellerId: string) => {
      await storage.forPlatform().deleteUnder(`brand/${resellerId}/`);
      for (const table of [
        'brands',
        'console_hostnames',
        'tls_certificates',
        'reseller_base_domains',
      ] as const) {
        await trx.deleteFrom(table).where('reseller_id', '=', resellerId).execute();
      }
    },
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
  });
}
