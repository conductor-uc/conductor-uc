import { randomUUID } from 'node:crypto';

import type { Database } from '@cuc/db';
import { createConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import { brandOf, NEUTRAL_BRAND, type MailBrand } from '../domain/brand.js';
import { notificationEvents } from '../events.js';
import type { Mailer } from '../mailer.js';
import type { OrgClient } from '../org-client.js';
import { renderEmail, validFor, type TemplateName } from '../render.js';
import type { NotificationServiceDb } from '../schema.js';

interface ResetData {
  readonly orgId: string;
  readonly email: string;
  readonly token: string;
  readonly expiresAt: string;
}
interface InvitationData {
  readonly orgId: string;
  readonly email: string;
  readonly displayName: string;
  readonly token: string;
  readonly expiresAt: string;
}

interface MfaResetData {
  readonly orgId: string;
  readonly email: string;
  readonly displayName: string;
}

export interface IdentityConsumerOptions {
  readonly pullTimeoutMs?: number;
  /** Where links point when the org has no reseller console hostname. */
  readonly defaultConsoleBase: string;
  /** `https` or `http`, for a reseller console hostname. */
  readonly linkScheme: string;
  /** A full base URL that replaces any derived one (development). */
  readonly consoleUrlOverride?: string;
}

/**
 * Sends the emails identity-service's events ask for: a password-reset link,
 * an invitation, and the notice that an admin reset someone's two-step
 * verification (S3-03). The brand comes from org-service (02 §5.2), the
 * email is rendered with it or with the neutral presentation, and it goes out
 * through the SMTP relay.
 *
 * A failure anywhere (org-service unreachable, the relay down) throws, so the
 * event is redelivered and retried; only a stale event, whose link has already
 * expired, is dropped without sending. Delivery is at-least-once: a crash
 * between the relay accepting a message and the row being recorded can send
 * it twice.
 */
export function createIdentityConsumer(
  db: Database<NotificationServiceDb>,
  bus: Bus,
  logger: Logger,
  orgClient: OrgClient,
  mailer: Mailer,
  options: IdentityConsumerOptions,
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
    durable: 'notification-identity',
    subjects: [
      'identity.user.password_reset_requested',
      'identity.invitation.created',
      'identity.user.mfa_reset',
    ],
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
    handler: async (envelope, trx) => {
      let template: TemplateName;
      let data: ResetData | InvitationData | MfaResetData;
      let path: string;
      switch (envelope.type) {
        case 'identity.user.password_reset_requested':
          template = 'password-reset';
          data = envelope.data as ResetData;
          path = '/reset/confirm';
          break;
        case 'identity.invitation.created':
          template = 'invitation';
          data = envelope.data as InvitationData;
          path = '/invite';
          break;
        case 'identity.user.mfa_reset':
          template = 'mfa-reset';
          data = envelope.data as MfaResetData;
          path = '/login';
          break;
        default:
          return;
      }

      // A one-time link goes stale; the MFA-reset notice has none, and is
      // worth sending however late it arrives.
      const expiresAt = 'expiresAt' in data ? new Date(data.expiresAt) : undefined;
      if (expiresAt !== undefined && expiresAt.getTime() <= Date.now()) {
        logger.warn({ eventId: envelope.id, template }, 'link already expired; not sending');
        return;
      }

      const resolved = await orgClient.mailBrand(data.orgId);
      if (resolved === undefined) {
        logger.warn({ orgId: data.orgId, template }, 'org not found; sending neutral');
      }
      const brand: MailBrand = resolved === undefined ? NEUTRAL_BRAND : brandOf(resolved);
      // The sign-in page carries no credential; the others carry their token.
      const query = 'token' in data ? `?token=${encodeURIComponent(data.token)}` : '';
      const link = `${linkBase(resolved?.consoleHostname ?? null)}${path}${query}`;

      const mail = await renderEmail({
        template,
        brand,
        email: data.email,
        ...('displayName' in data ? { name: data.displayName } : {}),
        link,
        ...(expiresAt === undefined ? {} : { validFor: validFor(expiresAt) }),
      });

      await mailer.send({
        to: data.email,
        fromName: brand.emailFromName ?? brand.displayName,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      });

      await trx
        .insertInto('sent_emails')
        .values({
          id: randomUUID(),
          event_id: envelope.id,
          template,
          to_address: data.email,
          org_id: data.orgId,
          brand_reseller: null,
          sent_at: new Date(),
        })
        .execute();
      // Never the token or the link: they are credentials.
      logger.info({ eventId: envelope.id, template, orgId: data.orgId }, 'email sent');
    },
  });
}
