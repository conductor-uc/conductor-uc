import { Type } from '@cuc/api-contracts';
import type { Logger } from '@cuc/logger';
import type { Kysely, Transaction } from 'kysely';

import type { Bus } from './bus.js';
import { createConsumer, type EventConsumer } from './consumer.js';
import type { EventTables } from './schema.js';

/**
 * org-service's `org.{tenant,reseller}.deleted` contracts (S1-16, G-11 (3)), for
 * a service to spread into its own `defineEvents` registry: a consumer needs
 * the contract in its registry to validate what it receives, and these must
 * match org-service's definitions exactly.
 */
export const ORG_DELETED_EVENTS = {
  'org.tenant.deleted': {
    schemaVersion: 1,
    description: 'A tenant was deleted; every service removes its data.',
    data: Type.Object({ orgId: Type.String({ minLength: 1 }) }),
  },
  'org.reseller.deleted': {
    schemaVersion: 1,
    description: 'A reseller was deleted; every service removes its data.',
    data: Type.Object({ orgId: Type.String({ minLength: 1 }) }),
  },
} as const;

export interface OrgDeletedConsumerOptions<TDb extends EventTables> {
  readonly db: Kysely<TDb>;
  readonly bus: Bus;
  readonly logger: Logger;
  /** The service's registry, which must include {@link ORG_DELETED_EVENTS}. */
  readonly registry: Parameters<typeof createConsumer<TDb>>[0]['registry'];
  /** Stable, per service: `<service>-org-deleted`. */
  readonly durable: string;
  /** Removes a deleted tenant's rows, in the consumer's transaction. Must be safe to repeat. */
  readonly tenant?: (trx: Transaction<TDb>, tenantId: string) => Promise<void>;
  /** Removes a deleted reseller's own rows (it has no tenants left by then). */
  readonly reseller?: (trx: Transaction<TDb>, resellerId: string) => Promise<void>;
  readonly pullTimeoutMs?: number;
}

/**
 * S1-16 (G-11 (3)): a service's consumer of org deletions. Each service
 * removes only its own rows (object storage is purged once, by org-service,
 * since a tenant's bucket is shared by every service). Retried for a long
 * time rather than the usual five deliveries: a deletion that gives up would
 * leave a deleted org's data behind.
 */
export function createOrgDeletedConsumer<TDb extends EventTables>(
  options: OrgDeletedConsumerOptions<TDb>,
): EventConsumer {
  const { logger } = options;
  const subjects = [
    ...(options.tenant === undefined ? [] : ['org.tenant.deleted']),
    ...(options.reseller === undefined ? [] : ['org.reseller.deleted']),
  ];
  return createConsumer<TDb>({
    db: options.db,
    bus: options.bus,
    logger,
    registry: options.registry,
    durable: options.durable,
    subjects,
    maxDeliver: 50,
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
    handler: async (envelope, trx) => {
      const { orgId } = envelope.data as { orgId: string };
      if (envelope.type === 'org.tenant.deleted') await options.tenant?.(trx, orgId);
      else if (envelope.type === 'org.reseller.deleted') await options.reseller?.(trx, orgId);
      else return;
      logger.info({ orgId, event: envelope.type }, 'org deletion: this service removed its data');
    },
  });
}
