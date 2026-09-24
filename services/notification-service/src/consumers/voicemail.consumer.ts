import { randomUUID } from 'node:crypto';

import type { Database } from '@cuc/db';
import { createConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import { brandOf, NEUTRAL_BRAND, type MailBrand } from '../domain/brand.js';
import { notificationEvents } from '../events.js';
import type { EmailAttachment, Mailer } from '../mailer.js';
import type { OrgClient } from '../org-client.js';
import { renderEmail, type VoicemailAudio } from '../render.js';
import type { NotificationServiceDb } from '../schema.js';
import type { VoicemailClient } from '../voicemail-client.js';

export interface VoicemailConsumerOptions {
  readonly pullTimeoutMs?: number;
  /** Where links point when the org has no reseller console hostname. */
  readonly defaultConsoleBase: string;
  readonly linkScheme: string;
  readonly consoleUrlOverride?: string;
  /** The largest recording attached, in bytes; a bigger one is left out and the email says so. */
  readonly maxAttachmentBytes: number;
}

/**
 * Emails a mailbox's owner when a message is left (S5-07; 06's
 * notification-service "voicemail-to-email").
 *
 * The event is thin (`{messageId, mailboxId}` plus the tenant in its
 * `orgContext`), so everything else is read from voicemail-service's internal
 * API: the mailbox's email settings, the message details and, when the mailbox
 * asks for it, the audio. The email carries the tenant's reseller brand, or the
 * neutral presentation for a direct or master-tier tenant (02 §5), exactly as
 * the identity emails do.
 *
 * Voicemail is private-class data (07 §3.3, H1). This code never logs a
 * recipient address, a caller ID, a duration or any audio: only the event id,
 * template and tenant.
 *
 * After sending, the mailbox's `emailAfter` choice is applied through
 * voicemail-service: `mark_read`, or `delete`. Delete happens only when the
 * audio was really attached, so a too-large recording is never destroyed
 * on the strength of an email that does not contain it. Those follow-ups are
 * best effort: a failure is logged and not retried, because retrying would
 * send the email again.
 *
 * A failure before the send (voicemail-service or org-service unreachable, the
 * relay down) throws, so the event is redelivered. A message or mailbox that
 * has since been deleted, or a mailbox with no address, is dropped quietly.
 */
export function createVoicemailConsumer(
  db: Database<NotificationServiceDb>,
  bus: Bus,
  logger: Logger,
  orgClient: OrgClient,
  voicemail: VoicemailClient,
  mailer: Mailer,
  options: VoicemailConsumerOptions,
): EventConsumer {
  function linkBase(hostname: string | null): string {
    if (options.consoleUrlOverride !== undefined)
      return options.consoleUrlOverride.replace(/\/+$/, '');
    return hostname === null ? options.defaultConsoleBase : `${options.linkScheme}://${hostname}`;
  }

  return createConsumer<NotificationServiceDb>({
    db: db.kysely,
    bus,
    logger,
    registry: notificationEvents,
    durable: 'notification-voicemail',
    subjects: ['voicemail.message.created'],
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
    handler: async (envelope, trx) => {
      if (envelope.type !== 'voicemail.message.created') return;
      const { messageId, mailboxId } = envelope.data as { messageId: string; mailboxId: string };
      const tenantId = envelope.orgContext.tenantId;
      if (tenantId === undefined) {
        logger.warn({ eventId: envelope.id }, 'voicemail event has no tenant; not sending');
        return;
      }

      const mailbox = await voicemail.mailbox(tenantId, mailboxId);
      if (mailbox === undefined || mailbox.notifyEmail === null) return;
      const message = await voicemail.message(tenantId, mailboxId, messageId);
      if (message === undefined || message.status !== 'ready') return;

      // Attach the recording only when it is asked for and known to fit.
      let audio: VoicemailAudio = 'not_requested';
      let attachments: EmailAttachment[] = [];
      if (mailbox.emailAttachAudio) {
        audio = 'too_large';
        if (message.sizeBytes !== null && message.sizeBytes <= options.maxAttachmentBytes) {
          const bytes = await voicemail.audio(tenantId, mailboxId, messageId);
          if (bytes !== undefined && bytes.length <= options.maxAttachmentBytes) {
            audio = 'attached';
            attachments = [{ filename: 'voicemail.wav', content: bytes, contentType: 'audio/wav' }];
          }
        }
      }

      const resolved = await orgClient.mailBrand(tenantId);
      if (resolved === undefined) {
        logger.warn({ orgId: tenantId, template: 'voicemail' }, 'org not found; sending neutral');
      }
      const brand: MailBrand = resolved === undefined ? NEUTRAL_BRAND : brandOf(resolved);
      const link = `${linkBase(resolved?.consoleHostname ?? null)}/voicemail`;

      const mail = await renderEmail({
        template: 'voicemail',
        brand,
        email: mailbox.notifyEmail,
        link,
        voicemail: {
          callerName: message.callerIdName,
          callerNumber: message.callerIdNumber,
          receivedAt: new Date(message.createdAt),
          durationMs: message.durationMs,
          audio,
        },
      });

      await mailer.send({
        to: mailbox.notifyEmail,
        fromName: brand.emailFromName ?? brand.displayName,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        ...(attachments.length === 0 ? {} : { attachments }),
      });

      await trx
        .insertInto('sent_emails')
        .values({
          id: randomUUID(),
          event_id: envelope.id,
          template: 'voicemail',
          to_address: mailbox.notifyEmail,
          org_id: tenantId,
          brand_reseller: null,
          sent_at: new Date(),
        })
        .execute();
      logger.info(
        { eventId: envelope.id, template: 'voicemail', orgId: tenantId, audio },
        'email sent',
      );

      try {
        if (mailbox.emailAfter === 'delete' && audio === 'attached') {
          await voicemail.remove(tenantId, mailboxId, messageId);
        } else if (mailbox.emailAfter === 'mark_read' || mailbox.emailAfter === 'delete') {
          // `delete` without the audio degrades to `mark_read`: keep the only copy.
          await voicemail.markRead(tenantId, mailboxId, messageId);
        }
      } catch {
        logger.warn(
          { eventId: envelope.id, template: 'voicemail', orgId: tenantId },
          'email sent but the follow-up action failed; not retrying',
        );
      }
    },
  });
}
