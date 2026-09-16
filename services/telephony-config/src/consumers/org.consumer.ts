import type { Database } from '@cuc/db';
import { createConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import { telephonyEvents } from '../events.js';
import type { OrgClient } from '../org-client.js';
import type { Projection } from '../projection.js';
import type { ReadModelRepo } from '../repo/read-model.repo.js';
import type { TelephonyConfigDb } from '../schema.js';

interface TenantCreatedData {
  readonly orgId: string;
}
interface TenantStatusData {
  readonly orgId: string;
}
interface DomainAddedData {
  readonly domainId: string;
  readonly fqdn: string;
  readonly scope: 'tenant' | 'reseller_base';
  readonly ownerId: string;
}

export interface OrgConsumerOptions {
  /** How long one pull waits for a message (`@cuc/events`' default: 1s). Longer in tests. */
  readonly pullTimeoutMs?: number;
}

/**
 * The `ORG` stream consumer (S1-12): `org.tenant.created`, `.suspended`,
 * `.resumed`, and `org.domain.added`.
 *
 * All four are handled here rather than split across files — they share one
 * JetStream stream (`createConsumer` reads exactly one) and one concern:
 * keeping `tenants`/`domains` and the `opensips.domain` projection in sync
 * with org-service (02 §2's suspend/resume domain-removal rule; 02 §3's
 * domain-change invariant).
 */
export function createOrgConsumer(
  db: Database<TelephonyConfigDb>,
  bus: Bus,
  logger: Logger,
  readModel: ReadModelRepo,
  projection: Projection,
  orgClient: OrgClient,
  options: OrgConsumerOptions = {},
): EventConsumer {
  return createConsumer<TelephonyConfigDb>({
    db: db.kysely,
    bus,
    logger,
    registry: telephonyEvents,
    durable: 'telephony-config-org',
    subjects: [
      'org.tenant.created',
      'org.tenant.suspended',
      'org.tenant.resumed',
      'org.domain.added',
    ],
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
    handler: async (envelope, trx) => {
      switch (envelope.type) {
        case 'org.tenant.created': {
          const data = envelope.data as TenantCreatedData;
          await readModel.upsertTenant(trx, { id: data.orgId, status: 'active' });

          // S2-04: fetched once here, not re-fetched on later
          // `org.tenant.updated` (this consumer does not subscribe to it —
          // `events.ts`'s own comment on why) — a tenant that changes
          // country later keeps normalizing against the old one until a
          // gap this task does not close (docs/decisions.md) is fixed.
          const country = await orgClient.findCountry(data.orgId);
          if (country !== undefined) {
            await readModel.setTenantCountry(trx, data.orgId, country);
          } else {
            logger.warn(
              { tenantId: data.orgId },
              'tenant not found in org-service for country lookup',
            );
          }
          return;
        }

        case 'org.tenant.suspended': {
          const data = envelope.data as TenantStatusData;
          await readModel.setTenantStatus(trx, data.orgId, 'suspended');
          const domain = await readModel.findDomain(trx, data.orgId);
          if (domain !== undefined) await projection.deactivateDomain(domain.fqdn);
          return;
        }

        case 'org.tenant.resumed': {
          const data = envelope.data as TenantStatusData;
          await readModel.setTenantStatus(trx, data.orgId, 'active');
          const domain = await readModel.findDomain(trx, data.orgId);
          if (domain !== undefined) await projection.activateDomain(domain.fqdn, data.orgId);
          return;
        }

        case 'org.domain.added': {
          const data = envelope.data as DomainAddedData;
          // A reseller base domain (e.g. voice.reseller-brand.com) is never
          // itself a SIP domain OpenSIPs authenticates against — only the
          // concrete tenant domains under it are (02 §3).
          if (data.scope !== 'tenant') return;

          const tenantId = data.ownerId;
          const previous = await readModel.upsertDomain(trx, {
            id: data.domainId,
            tenantId,
            fqdn: data.fqdn,
          });

          // Unknown here only if this event somehow arrives before
          // `org.tenant.created` for the same tenant — org-service enqueues
          // both in the same transaction, tenant row first, so JetStream's
          // per-stream ordering makes that unreachable in practice. Default
          // to active (a fresh tenant's real status) rather than silently
          // dropping the domain.
          const tenant = await readModel.findTenant(trx, tenantId);
          const isActive = tenant === undefined || tenant.status === 'active';

          if (previous !== undefined && previous.fqdn !== data.fqdn) {
            await projection.deactivateDomain(previous.fqdn);
          }
          if (isActive) await projection.activateDomain(data.fqdn, tenantId);

          // 02 §3: a domain change invalidates every credential computed
          // under the old realm. pbx-config-service's own domain consumer
          // (S1-09) recomputes HA1/HA1B for the same event independently;
          // this re-fetches and re-projects every extension this service
          // already knows for the tenant so the `subscriber` rows follow.
          // Unreachable today (no API changes an existing tenant's domain,
          // so this only ever fires for a brand-new tenant with zero
          // extensions yet) but kept for when one exists, matching
          // pbx-config-service's own defensive precedent. A handler here
          // racing ahead of pbx-config-service's own recompute would
          // project a stale HA1 until the next reconciliation pass
          // (`reconcile.ts`) — an accepted, bounded staleness window, the
          // same one 06 already prices in ("repairs drift" every 15 min).
          if (previous !== undefined && previous.fqdn !== data.fqdn) {
            const extensions = await readModel.listExtensionsForTenant(trx, tenantId);
            for (const extension of extensions) {
              await projection.projectExtension(trx, tenantId, extension.id);
            }
          }
          return;
        }

        default:
          // Unreachable: `subjects` above is the exhaustive filter JetStream
          // applies before this handler ever runs.
          logger.warn({ type: envelope.type }, 'org consumer received an unhandled event type');
      }
    },
  });
}
