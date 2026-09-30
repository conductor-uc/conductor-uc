import type { Database } from '@cuc/db';
import { createConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import { telephonyEvents } from '../events.js';
import type { MwiPublisher } from '../mwi.js';
import type { TelephonyConfigDb } from '../schema.js';

export interface VoicemailConsumerOptions {
  readonly pullTimeoutMs?: number;
}

/**
 * The `VOICEMAIL` stream's `voicemail.mailbox.mwi_changed` (S2-16, G-42): a mailbox's unread
 * state changed, so its message-waiting summary is announced again (`mwi.ts`). The event says
 * only which mailbox; the counts are read from voicemail-service at that moment, so events
 * handled late or twice still announce the present state. When the edge or voicemail-service
 * cannot be reached the handler fails and the event is delivered again.
 */
export function createVoicemailConsumer(
  db: Database<TelephonyConfigDb>,
  bus: Bus,
  logger: Logger,
  mwi: MwiPublisher,
  options: VoicemailConsumerOptions = {},
): EventConsumer {
  return createConsumer<TelephonyConfigDb>({
    db: db.kysely,
    bus,
    logger,
    registry: telephonyEvents,
    durable: 'telephony-config-voicemail',
    subjects: ['voicemail.mailbox.mwi_changed'],
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
    handler: async (envelope) => {
      const tenantId = envelope.orgContext.tenantId;
      if (tenantId === undefined) {
        logger.warn({ eventId: envelope.id }, 'message-waiting event with no tenantId; skipping');
        return;
      }
      const { mailboxId, extensionId } = envelope.data as {
        mailboxId: string;
        extensionId?: string;
      };
      await mwi.publishMailbox(tenantId, mailboxId, extensionId);
    },
  });
}
