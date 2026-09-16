import type { Database } from '@cuc/db';
import { createConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import { telephonyEvents } from '../events.js';
import type { Projection } from '../projection.js';
import type { TelephonyConfigDb } from '../schema.js';

interface TrunkEventData {
  readonly trunkId: string;
}

interface OutboundRouteEventData {
  readonly outboundRouteId: string;
}

export interface TrunkConsumerOptions {
  /** How long one pull waits for a message (`@cuc/events`' default: 1s). Longer in tests. */
  readonly pullTimeoutMs?: number;
}

/**
 * The `TRUNK` stream consumer (S2-02; S2-04 adds `trunk.outbound_route.*`):
 * `trunk.trunk.created`, `.updated`, `.deleted` keep
 * `opensips.registrant`/`address`/`dr_gateways` in sync with trunk-service,
 * and `trunk.outbound_route.created`, `.updated`, `.deleted` keep
 * `opensips.dr_rules` in sync.
 *
 * Every event carries only an id (06: events stay thin), so `created`/
 * `updated` both re-fetch current state rather than trusting anything in
 * the payload — same story as `pbx.consumer.ts`/`projectExtension`.
 *
 * `envelope.orgContext.tenantId` is trusted here: trunk-service's own
 * repos set it explicitly on every event they publish, the same as
 * pbx-config-service does for `pbx.extension.*`/`pbx.did.*`.
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
    subjects: [
      'trunk.trunk.created',
      'trunk.trunk.updated',
      'trunk.trunk.deleted',
      'trunk.outbound_route.created',
      'trunk.outbound_route.updated',
      'trunk.outbound_route.deleted',
    ],
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
    handler: async (envelope, trx) => {
      const tenantId = envelope.orgContext.tenantId;
      if (tenantId === undefined) {
        logger.warn({ eventId: envelope.id }, 'trunk event with no tenantId; skipping');
        return;
      }

      switch (envelope.type) {
        case 'trunk.trunk.created':
        case 'trunk.trunk.updated':
          await projection.projectTrunk(trx, tenantId, (envelope.data as TrunkEventData).trunkId);
          return;

        case 'trunk.trunk.deleted':
          await projection.removeTrunk(trx, (envelope.data as TrunkEventData).trunkId);
          return;

        case 'trunk.outbound_route.created':
        case 'trunk.outbound_route.updated':
          await projection.projectOutboundRoute(
            trx,
            tenantId,
            (envelope.data as OutboundRouteEventData).outboundRouteId,
          );
          return;

        case 'trunk.outbound_route.deleted':
          await projection.removeOutboundRoute(
            trx,
            (envelope.data as OutboundRouteEventData).outboundRouteId,
          );
          return;

        default:
          // Unreachable: `subjects` above is the exhaustive filter JetStream
          // applies before this handler ever runs.
          logger.warn({ type: envelope.type }, 'trunk consumer received an unhandled event type');
      }
    },
  });
}
