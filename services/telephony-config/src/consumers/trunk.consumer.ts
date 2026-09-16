import type { Database } from '@cuc/db';
import { createConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import { telephonyEvents } from '../events.js';
import type { Projection } from '../projection.js';
import type { TelephonyConfigDb } from '../schema.js';

interface TrunkEventData {
  readonly trunkId: string;
}

export interface TrunkConsumerOptions {
  /** How long one pull waits for a message (`@cuc/events`' default: 1s). Longer in tests. */
  readonly pullTimeoutMs?: number;
}

/**
 * The `TRUNK` stream consumer (S2-02): `trunk.trunk.created`, `.updated`,
 * `.deleted` — keeps `opensips.registrant`/`address`/`dr_gateways` in sync
 * with trunk-service.
 *
 * Every event carries only `trunkId` (06: events stay thin), so
 * `created`/`updated` both re-fetch the trunk's current full config rather
 * than trusting anything in the payload — same story as
 * `pbx.consumer.ts`/`projectExtension`.
 *
 * `envelope.orgContext.tenantId` is trusted here: trunk-service's own
 * `trunk.repo.ts` sets it explicitly on every `trunk.trunk.*` event, the
 * same as pbx-config-service does for `pbx.extension.*`.
 */
export function createTrunkConsumer(
  db: Database<TelephonyConfigDb>,
  bus: Bus,
  logger: Logger,
  projection: Projection,
  options: TrunkConsumerOptions = {},
): EventConsumer {
  return createConsumer<TelephonyConfigDb>({
    db: db.kysely,
    bus,
    logger,
    registry: telephonyEvents,
    durable: 'telephony-config-trunk',
    subjects: ['trunk.trunk.created', 'trunk.trunk.updated', 'trunk.trunk.deleted'],
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
    handler: async (envelope, trx) => {
      const data = envelope.data as TrunkEventData;
      const tenantId = envelope.orgContext.tenantId;
      if (tenantId === undefined) {
        logger.warn({ eventId: envelope.id }, 'trunk.trunk event with no tenantId; skipping');
        return;
      }

      switch (envelope.type) {
        case 'trunk.trunk.created':
        case 'trunk.trunk.updated':
          await projection.projectTrunk(trx, tenantId, data.trunkId);
          return;

        case 'trunk.trunk.deleted':
          await projection.removeTrunk(trx, data.trunkId);
          return;

        default:
          // Unreachable: `subjects` above is the exhaustive filter JetStream
          // applies before this handler ever runs.
          logger.warn({ type: envelope.type }, 'trunk consumer received an unhandled event type');
      }
    },
  });
}
