import type { Database } from '@cuc/db';
import { createConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import { telephonyEvents } from '../events.js';
import type { Projection } from '../projection.js';
import type { TelephonyConfigDb } from '../schema.js';

interface ExtensionEventData {
  readonly extensionId: string;
}

interface DidEventData {
  readonly didId: string;
}

interface RingGroupEventData {
  readonly ringGroupId: string;
}

interface QueueEventData {
  readonly queueId: string;
}

interface AgentEventData {
  readonly agentId: string;
}

interface QueueTierEventData {
  readonly queueId: string;
  readonly agentId: string;
}

interface ParkingLotEventData {
  readonly parkingLotId: string;
}

interface ConferenceRoomEventData {
  readonly conferenceRoomId: string;
}

export interface PbxConsumerOptions {
  /** How long one pull waits for a message (`@cuc/events`' default: 1s). Longer in tests. */
  readonly pullTimeoutMs?: number;
}

/**
 * The `PBX` stream consumer (S1-12; S2-03 added `pbx.did.*`):
 * `pbx.extension.created`, `.updated`, `.deleted` keep `opensips.subscriber`
 * in sync with pbx-config-service, and `pbx.did.created`, `.updated`,
 * `.deleted` keep this service's own local `dids` mirror in sync (no
 * `opensips` counterpart — `projection.ts`'s `projectDid` comment).
 *
 * Every event carries only an id (06: events stay thin), so `created`/
 * `updated` both re-fetch current state rather than trusting anything in the
 * payload — see `projection.ts`'s `projectExtension`/`projectDid` for why
 * `updated` is not a no-op.
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
    subjects: [
      'pbx.extension.created',
      'pbx.extension.updated',
      'pbx.extension.deleted',
      'pbx.call_handling.updated',
      'pbx.did.created',
      'pbx.did.updated',
      'pbx.did.deleted',
      'pbx.ring_group.created',
      'pbx.ring_group.updated',
      'pbx.ring_group.deleted',
      'pbx.queue.created',
      'pbx.queue.updated',
      'pbx.queue.deleted',
      'pbx.agent.created',
      'pbx.agent.updated',
      'pbx.agent.deleted',
      'pbx.queue_tier.added',
      'pbx.queue_tier.updated',
      'pbx.queue_tier.removed',
      'pbx.parking_lot.created',
      'pbx.parking_lot.updated',
      'pbx.parking_lot.deleted',
      'pbx.conference_room.created',
      'pbx.conference_room.updated',
      'pbx.conference_room.deleted',
    ],
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
    handler: async (envelope, trx) => {
      const tenantId = envelope.orgContext.tenantId;
      if (tenantId === undefined) {
        logger.warn({ eventId: envelope.id }, 'pbx event with no tenantId; skipping');
        return;
      }

      switch (envelope.type) {
        case 'pbx.extension.created':
        case 'pbx.extension.updated':
          await projection.projectExtension(
            trx,
            tenantId,
            (envelope.data as ExtensionEventData).extensionId,
          );
          return;

        case 'pbx.call_handling.updated':
          await projection.projectCallHandling(
            trx,
            tenantId,
            (envelope.data as ExtensionEventData).extensionId,
          );
          return;

        case 'pbx.extension.deleted':
          await projection.removeExtension(trx, (envelope.data as ExtensionEventData).extensionId);
          return;

        case 'pbx.did.created':
        case 'pbx.did.updated':
          await projection.projectDid(trx, tenantId, (envelope.data as DidEventData).didId);
          return;

        case 'pbx.did.deleted':
          await projection.removeDid(trx, (envelope.data as DidEventData).didId);
          return;

        case 'pbx.ring_group.created':
        case 'pbx.ring_group.updated':
          await projection.projectRingGroup(
            trx,
            tenantId,
            (envelope.data as RingGroupEventData).ringGroupId,
          );
          return;

        case 'pbx.ring_group.deleted':
          await projection.removeRingGroup(trx, (envelope.data as RingGroupEventData).ringGroupId);
          return;

        case 'pbx.queue.created':
        case 'pbx.queue.updated':
          await projection.projectQueue(trx, tenantId, (envelope.data as QueueEventData).queueId);
          return;

        case 'pbx.queue.deleted':
          await projection.removeQueue(trx, (envelope.data as QueueEventData).queueId);
          return;

        case 'pbx.agent.created':
        case 'pbx.agent.updated':
          await projection.projectAgent(trx, tenantId, (envelope.data as AgentEventData).agentId);
          return;

        case 'pbx.agent.deleted':
          await projection.removeAgent(trx, (envelope.data as AgentEventData).agentId);
          return;

        case 'pbx.queue_tier.added':
        case 'pbx.queue_tier.updated':
        case 'pbx.queue_tier.removed':
          await projection.projectQueueTiers(
            trx,
            tenantId,
            (envelope.data as QueueTierEventData).queueId,
          );
          return;

        case 'pbx.parking_lot.created':
        case 'pbx.parking_lot.updated':
          await projection.projectParkingLot(
            trx,
            tenantId,
            (envelope.data as ParkingLotEventData).parkingLotId,
          );
          return;

        case 'pbx.parking_lot.deleted':
          await projection.removeParkingLot(
            trx,
            (envelope.data as ParkingLotEventData).parkingLotId,
          );
          return;

        case 'pbx.conference_room.created':
        case 'pbx.conference_room.updated':
          await projection.projectConferenceRoom(
            trx,
            tenantId,
            (envelope.data as ConferenceRoomEventData).conferenceRoomId,
          );
          return;

        case 'pbx.conference_room.deleted':
          await projection.removeConferenceRoom(
            trx,
            (envelope.data as ConferenceRoomEventData).conferenceRoomId,
          );
          return;

        default:
          // Unreachable: `subjects` above is the exhaustive filter JetStream
          // applies before this handler ever runs.
          logger.warn({ type: envelope.type }, 'pbx consumer received an unhandled event type');
      }
    },
  });
}
