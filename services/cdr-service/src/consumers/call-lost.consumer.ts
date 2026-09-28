import type { Database } from '@cuc/db';
import { createConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import type { TenantResellerLookup } from '../org-client.js';
import type { CdrDirection, NormalizedCdr } from '../domain/cdr.js';
import { cdrEvents } from '../events.js';
import { CdrAlreadyIngestedError, type CdrRepo } from '../repo/cdr.repo.js';
import type { CdrServiceDb } from '../schema.js';

interface CallLostData {
  readonly callUuid: string;
  readonly nodeId: string;
  readonly direction: 'inbound' | 'outbound';
  readonly startedAt: number;
  readonly answeredAt: number | null;
  readonly detectedAt: number;
  readonly from: string;
  readonly to: string;
}

/**
 * The call's direction as far as a lost leg can tell: a caller with a full
 * number reaching the node is a call from outside, a full number the node
 * dialed is a call out, anything else between extensions.
 */
function directionOf(data: CallLostData): CdrDirection {
  if (data.direction === 'inbound' && data.from.startsWith('+')) return 'inbound';
  if (data.to.startsWith('+')) return 'outbound';
  return 'internal';
}

/** A synthetic record for a leg lost with its node (S4-04, 04 §4). */
export function lostCallCdr(tenantId: string, data: CallLostData): NormalizedCdr {
  // Whole seconds, as a real record's `start_epoch` is, so a real record that
  // somehow arrives later is recognised as the same call (the dedupe key is
  // call, node and start).
  const startAt = new Date(Math.floor(data.startedAt / 1000) * 1000);
  const endAt = new Date(Math.max(data.detectedAt, data.startedAt));
  const answerAt = data.answeredAt === null ? null : new Date(data.answeredAt);
  return {
    tenantId,
    callUuid: data.callUuid,
    nodeId: data.nodeId,
    direction: directionOf(data),
    startAt,
    answerAt,
    endAt,
    durationSec: Math.max(0, Math.round((endAt.getTime() - data.startedAt) / 1000)),
    billableSec:
      answerAt === null
        ? 0
        : Math.max(0, Math.round((endAt.getTime() - answerAt.getTime()) / 1000)),
    fromNumber: data.from,
    fromName: null,
    toNumber: data.to,
    dialedNumber: data.to,
    did: null,
    trunkId: null,
    disposition: 'node_failure',
    hangupCause: 'NODE_FAILURE',
    hangupBy: 'system',
    legs: null,
    sip: {},
  };
}

/**
 * S4-04: `call.lost`, a leg whose media node died, becomes a call record
 * flagged `disposition: node_failure` (a dead node never sends its own). A
 * leg with no tenant yet (a trunk call lost before its dialplan ran) is not
 * anyone's record, and is skipped.
 */
export function createCallLostConsumer(
  db: Database<CdrServiceDb>,
  bus: Bus,
  logger: Logger,
  cdrRepo: CdrRepo,
  resellerForTenant: TenantResellerLookup,
  options: { readonly pullTimeoutMs?: number } = {},
): EventConsumer {
  return createConsumer<CdrServiceDb>({
    db: db.kysely,
    bus,
    logger,
    registry: cdrEvents,
    durable: 'cdr-service-call-lost',
    subjects: ['call.lost'],
    maxDeliver: 20,
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
    handler: async (envelope) => {
      const tenantId = envelope.orgContext.tenantId;
      const data = envelope.data as CallLostData;
      if (tenantId === undefined) {
        logger.info({ callUuid: data.callUuid }, 'a lost leg with no tenant; no call record');
        return;
      }
      let resellerId: string | null;
      try {
        resellerId = (await resellerForTenant(tenantId)) ?? null;
      } catch (error) {
        // As the ingest route does: the record matters more than its reseller.
        logger.warn(
          { err: error, tenantId },
          'could not resolve the owning reseller; recording without',
        );
        resellerId = null;
      }
      try {
        await cdrRepo.ingest(lostCallCdr(tenantId, data), resellerId);
      } catch (error) {
        if (error instanceof CdrAlreadyIngestedError) return;
        throw error;
      }
    },
  });
}
