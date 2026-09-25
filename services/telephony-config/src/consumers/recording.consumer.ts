import type { Database } from '@cuc/db';
import { createConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import { telephonyEvents } from '../events.js';
import type { ReadModelRepo } from '../repo/read-model.repo.js';
import type { TelephonyConfigDb } from '../schema.js';

interface RecordingSettingsData {
  readonly retentionDays: number;
  readonly failClosed: boolean;
}

export interface RecordingConsumerOptions {
  readonly pullTimeoutMs?: number;
}

/**
 * The `RECORDING` stream's `recording.settings.updated` (S5-12, G-111): keeps this service's own
 * copy of each tenant's "recording required" (fail-closed) flag, which `/fs/dialplan` reads when a
 * recording decision is unavailable. The event carries the flag itself, so nothing is fetched: the
 * copy stays correct while recording-service is down, which is the whole point. The reconciliation
 * pass (`reconcile.ts`) repairs a missed event.
 */
export function createRecordingConsumer(
  db: Database<TelephonyConfigDb>,
  bus: Bus,
  logger: Logger,
  readModel: ReadModelRepo,
  options: RecordingConsumerOptions = {},
): EventConsumer {
  return createConsumer<TelephonyConfigDb>({
    db: db.kysely,
    bus,
    logger,
    registry: telephonyEvents,
    durable: 'telephony-config-recording',
    subjects: ['recording.settings.updated'],
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
    handler: async (envelope, trx) => {
      const tenantId = envelope.orgContext.tenantId;
      if (tenantId === undefined) {
        logger.warn(
          { eventId: envelope.id },
          'recording settings event with no tenantId; skipping',
        );
        return;
      }
      const data = envelope.data as RecordingSettingsData;
      await readModel.upsertRecordingFailClosed(trx, tenantId, data.failClosed);
    },
  });
}
