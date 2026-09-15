import type { Database } from '@cuc/db';
import { createConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import { telephonyEvents } from '../events.js';
import type { Projection } from '../projection.js';
import type { TelephonyConfigDb } from '../schema.js';

interface ExtensionEventData {
  readonly extensionId: string;
}

export interface PbxConsumerOptions {
  /** How long one pull waits for a message (`@cuc/events`' default: 1s). Longer in tests. */
  readonly pullTimeoutMs?: number;
}

/**
 * The `PBX` stream consumer (S1-12): `pbx.extension.created`, `.updated`,
 * `.deleted` — keeps `opensips.subscriber` in sync with pbx-config-service.
 *
 * Every event carries only `extensionId` (06: events stay thin), so
 * `created`/`updated` both re-fetch the extension's current digest
 * credential rather than trusting anything in the payload — see
 * `projection.ts`'s `projectExtension` for why `updated` is not a no-op.
 *
 * `envelope.orgContext.tenantId` is trusted here: pbx-config-service's own
 * `extension.repo.ts` sets it explicitly on every `pbx.extension.*` event
 * (unlike org-service's own tenant/domain events, which do not — see
 * `org.consumer.ts`'s use of `data.orgId`/`data.ownerId` instead).
 */
export function createPbxConsumer(
  db: Database<TelephonyConfigDb>,
  bus: Bus,
  logger: Logger,
  projection: Projection,
  options: PbxConsumerOptions = {},
): EventConsumer {
  return createConsumer<TelephonyConfigDb>({
    db: db.kysely,
    bus,
    logger,
    registry: telephonyEvents,
    durable: 'telephony-config-pbx',
    subjects: ['pbx.extension.created', 'pbx.extension.updated', 'pbx.extension.deleted'],
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
    handler: async (envelope, trx) => {
      const data = envelope.data as ExtensionEventData;
      const tenantId = envelope.orgContext.tenantId;
      if (tenantId === undefined) {
        logger.warn({ eventId: envelope.id }, 'pbx.extension event with no tenantId; skipping');
        return;
      }

      switch (envelope.type) {
        case 'pbx.extension.created':
        case 'pbx.extension.updated':
          await projection.projectExtension(trx, tenantId, data.extensionId);
          return;

        case 'pbx.extension.deleted':
          await projection.removeExtension(trx, data.extensionId);
          return;

        default:
          // Unreachable: `subjects` above is the exhaustive filter JetStream
          // applies before this handler ever runs.
          logger.warn({ type: envelope.type }, 'pbx consumer received an unhandled event type');
      }
    },
  });
}
