import type { Database } from '@cuc/db';
import { createConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import { pbxEvents } from '../events.js';
import type { ExtensionRepo } from '../repo/extension.repo.js';
import type { PbxConfigServiceDb } from '../schema.js';

interface OrgDomainAddedData {
  readonly domainId: string;
  readonly fqdn: string;
  readonly scope: 'tenant' | 'reseller_base';
  readonly ownerId: string;
}

/**
 * The `ORG` stream consumer for `org.domain.added` (S1-09; 02 §3: "Changing
 * a tenant's primary domain invalidates stored SIP digest HA1 values").
 *
 * Only `scope: 'tenant'` events matter here — a reseller base domain has no
 * SIP credentials to recompute. `ownerId` is the tenant id and `fqdn` is the
 * new realm in that case, straight from org-service's own event (05 §5), so
 * no callback to org-service is needed to act on it.
 */
export interface DomainConsumerOptions {
  /** How long one pull waits for a message (`@cuc/events`' default: 1s). Longer in tests. */
  readonly pullTimeoutMs?: number;
}

export function createDomainConsumer(
  db: Database<PbxConfigServiceDb>,
  bus: Bus,
  logger: Logger,
  extensions: ExtensionRepo,
  options: DomainConsumerOptions = {},
): EventConsumer {
  return createConsumer<PbxConfigServiceDb>({
    db: db.kysely,
    bus,
    logger,
    registry: pbxEvents,
    durable: 'pbx-config-service-domain',
    subjects: ['org.domain.added'],
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
    handler: async (envelope, trx) => {
      const data = envelope.data as OrgDomainAddedData;
      if (data.scope !== 'tenant') return;

      const recomputed = await extensions.recomputeForDomainChange(trx, data.ownerId, data.fqdn);
      if (recomputed > 0) {
        logger.info(
          { tenantId: data.ownerId, realm: data.fqdn, recomputed },
          'recomputed SIP digest credentials for a tenant domain change',
        );
      }
    },
  });
}
