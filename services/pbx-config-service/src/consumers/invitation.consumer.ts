import type { Database } from '@cuc/db';
import { createConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import { pbxEvents } from '../events.js';
import { ExtensionUserTakenError, type ExtensionRepo } from '../repo/extension.repo.js';
import type { PbxConfigServiceDb } from '../schema.js';

interface InvitationAcceptedData {
  readonly invitationId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly extensionId: string | null;
}

export interface InvitationConsumerOptions {
  /** How long one pull waits for a message (`@cuc/events`' default: 1s). Longer in tests. */
  readonly pullTimeoutMs?: number;
}

/**
 * The `IDENTITY` stream consumer for `identity.invitation.accepted` (S9-07,
 * D-019). A person added in the console with an invitation has an extension
 * waiting for them; once they accept, it is linked to their new account, so
 * their own call handling, voicemail and history work without anyone coming
 * back to link them.
 *
 * Only an extension no one else has is linked: if it was given to someone
 * else meanwhile, or the person already has one, it is left alone and logged,
 * and an administrator links it by hand. Linking the same person again is a
 * no-op, so a redelivery changes nothing.
 */
export function createInvitationConsumer(
  db: Database<PbxConfigServiceDb>,
  bus: Bus,
  logger: Logger,
  extensions: ExtensionRepo,
  options: InvitationConsumerOptions = {},
): EventConsumer {
  return createConsumer<PbxConfigServiceDb>({
    db: db.kysely,
    bus,
    logger,
    registry: pbxEvents,
    durable: 'pbx-config-service-invitations',
    subjects: ['identity.invitation.accepted'],
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
    handler: async (envelope) => {
      const data = envelope.data as InvitationAcceptedData;
      if (data.extensionId === null) return;
      const ctx = {
        tenantId: data.orgId,
        orgId: data.orgId,
        orgType: 'tenant' as const,
        actorId: data.userId,
        ...(envelope.correlationId === undefined ? {} : { requestId: envelope.correlationId }),
      };
      const extension = await extensions.findById(ctx, data.extensionId);
      if (extension === undefined) {
        logger.warn({ ...data }, 'invited extension no longer exists; nothing to link');
        return;
      }
      if (extension.userId === data.userId) return;
      if (extension.userId !== null) {
        logger.warn({ ...data }, 'invited extension already belongs to someone else; not linked');
        return;
      }
      try {
        await extensions.update(ctx, data.extensionId, { userId: data.userId });
        logger.info({ ...data }, 'linked an invited person to their extension');
      } catch (error) {
        if (error instanceof ExtensionUserTakenError) {
          logger.warn({ ...data }, 'invited person already has an extension; not linked');
          return;
        }
        throw error;
      }
    },
  });
}
