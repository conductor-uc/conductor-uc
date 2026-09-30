import { randomUUID } from 'node:crypto';

import type { Database } from '@cuc/db';
import { createConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import { brandOf, NEUTRAL_BRAND, type MailBrand } from '../domain/brand.js';
import { notificationEvents } from '../events.js';
import type { Mailer } from '../mailer.js';
import type { OrgClient } from '../org-client.js';
import { renderEmail, type EmergencyLocation } from '../render.js';
import type { NotificationServiceDb } from '../schema.js';
import type { TrunkClient } from '../trunk-client.js';

export interface EmergencyConsumerOptions {
  readonly pullTimeoutMs?: number;
  /** Where links point when the org has no reseller console hostname. */
  readonly defaultConsoleBase: string;
  readonly linkScheme: string;
  readonly consoleUrlOverride?: string;
}

interface EmergencyData {
  readonly dialedNumber: string;
  readonly callingNumber?: string | null;
  readonly callingName?: string | null;
  readonly location?: EmergencyLocation | null;
}

/**
 * The on-site notification for an emergency call (S2-06, G-1; Kari's Law's "notification"):
 * when someone in a tenant dials one of its emergency numbers, every address on the tenant's
 * emergency route (trunk-service) is emailed who called, the number dialled, when, and the
 * location on file for the caller's extension.
 *
 * telephony-config's `call.emergency.initiated` carries the caller and the location as it
 * resolved them for the call itself, so nothing else is fetched but the recipients and the
 * brand. The email carries the tenant's reseller brand, or the neutral presentation (02 §5).
 *
 * Each address is sent to on its own: one the relay refuses does not keep the others from being
 * told. When none could be sent to (or trunk-service or org-service could not be reached) the
 * handler throws and the event is delivered again; a partial send is logged and not repeated.
 *
 * Private-class data (07 §3.3): the log names the event, tenant and counts, never an address,
 * the caller or the location.
 */
export function createEmergencyConsumer(
  db: Database<NotificationServiceDb>,
  bus: Bus,
  logger: Logger,
  orgClient: OrgClient,
  trunks: TrunkClient,
  mailer: Mailer,
  options: EmergencyConsumerOptions,
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
    durable: 'notification-emergency',
    subjects: ['call.emergency.initiated'],
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
    handler: async (envelope, trx) => {
      if (envelope.type !== 'call.emergency.initiated') return;
      const tenantId = envelope.orgContext.tenantId;
      if (tenantId === undefined) {
        logger.warn({ eventId: envelope.id }, 'emergency event has no tenant; not sending');
        return;
      }
      const data = envelope.data as EmergencyData;

      const recipients = await trunks.emergencyNotifyEmails(tenantId);
      if (recipients.length === 0) {
        logger.warn(
          { eventId: envelope.id, orgId: tenantId },
          'emergency call, but nobody is set to be emailed',
        );
        return;
      }

      const resolved = await orgClient.mailBrand(tenantId);
      const brand: MailBrand = resolved === undefined ? NEUTRAL_BRAND : brandOf(resolved);
      const link = `${linkBase(resolved?.consoleHostname ?? null)}/monitoring`;

      let sent = 0;
      for (const to of recipients) {
        const mail = await renderEmail({
          template: 'emergency',
          brand,
          email: to,
          link,
          emergency: {
            dialedNumber: data.dialedNumber,
            callingNumber: data.callingNumber ?? null,
            callingName: data.callingName ?? null,
            location: data.location ?? null,
            at: new Date(envelope.occurredAt),
          },
        });
        try {
          await mailer.send({
            to,
            fromName: brand.emailFromName ?? brand.displayName,
            subject: mail.subject,
            html: mail.html,
            text: mail.text,
          });
        } catch (error) {
          logger.error(
            {
              eventId: envelope.id,
              orgId: tenantId,
              err: error instanceof Error ? error.name : 'error',
            },
            'could not send one emergency email',
          );
          continue;
        }
        sent += 1;
        await trx
          .insertInto('sent_emails')
          .values({
            id: randomUUID(),
            event_id: envelope.id,
            template: 'emergency',
            to_address: to,
            org_id: tenantId,
            brand_reseller: null,
            sent_at: new Date(),
          })
          .execute();
      }

      if (sent === 0) throw new Error('No emergency email could be sent.');
      logger.info(
        {
          eventId: envelope.id,
          template: 'emergency',
          orgId: tenantId,
          sent,
          of: recipients.length,
        },
        'emergency emails sent',
      );
    },
  });
}
