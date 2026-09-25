import { randomUUID } from 'node:crypto';

import type { Database } from '@cuc/db';
import { createConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import { brandOf, NEUTRAL_BRAND, type MailBrand } from '../domain/brand.js';
import { notificationEvents } from '../events.js';
import type { IdentityClient, IssuedLink } from '../identity-client.js';
import type { Mailer } from '../mailer.js';
import type { OrgClient } from '../org-client.js';
import { renderEmail, validFor, type TemplateName } from '../render.js';
import type { NotificationServiceDb } from '../schema.js';

interface ResetData {
  readonly resetId: string;
  readonly orgId: string;
  readonly email: string;
  readonly expiresAt: string;
}
interface InvitationData {
  readonly invitationId: string;
  readonly orgId: string;
  readonly email: string;
  readonly displayName: string;
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
 * The reset and invitation events carry no token (G-55). Just before sending,
 * this asks identity-service to issue the link: a fresh token, returned once,
 * which replaces any earlier one. So a retried email carries a new link and
 * the one before it stops working. When identity-service will not issue one
 * (the reset or invitation is gone, used or expired, or the user was disabled
 * since) the event is consumed and nothing is sent.
 *
 * A failure anywhere else (org-service or identity-service unreachable, the
 * relay down) throws, so the event is redelivered and retried; only a stale
 * event, whose link has already expired, is dropped without sending. Delivery
 * is at-least-once: a crash between the relay accepting a message and the row
 * being recorded can send it twice, and then only the later email's link works.
 *
 * The token and the link are credentials: neither is logged or stored here.
 */
export function createIdentityConsumer(
  db: Database<NotificationServiceDb>,
  bus: Bus,
  logger: Logger,
  orgClient: OrgClient,
  identityClient: IdentityClient,
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
      /** Issues the one-time link at send time; absent for a notice that carries none. */
      let issueLink: (() => Promise<IssuedLink>) | undefined;
      switch (envelope.type) {
        case 'identity.user.password_reset_requested': {
          template = 'password-reset';
          const reset = envelope.data as ResetData;
          data = reset;
          path = '/reset/confirm';
          issueLink = () => identityClient.issuePasswordResetLink(reset.orgId, reset.resetId);
          break;
        }
        case 'identity.invitation.created': {
          template = 'invitation';
          const invitation = envelope.data as InvitationData;
          data = invitation;
          path = '/invite';
          issueLink = () =>
            identityClient.issueInvitationLink(invitation.orgId, invitation.invitationId);
          break;
        }
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
      let expiresAt = 'expiresAt' in data ? new Date(data.expiresAt) : undefined;
      if (expiresAt !== undefined && expiresAt.getTime() <= Date.now()) {
        logger.warn({ eventId: envelope.id, template }, 'link already expired; not sending');
        return;
      }

      const resolved = await orgClient.mailBrand(data.orgId);
      if (resolved === undefined) {
        logger.warn({ orgId: data.orgId, template }, 'org not found; sending neutral');
      }
      const brand: MailBrand = resolved === undefined ? NEUTRAL_BRAND : brandOf(resolved);

      // Issued as late as possible, right before rendering and sending, so a
      // failure before this point spends no token (G-55).
      let query = '';
      if (issueLink !== undefined) {
        const issued = await issueLink();
        if (issued.status === 'refused') {
          logger.info(
            {
              eventId: envelope.id,
              template,
              orgId: data.orgId,
              status: issued.httpStatus,
              ...(issued.code === undefined ? {} : { code: issued.code }),
            },
            'identity-service issued no link; not sending',
          );
          return;
        }
        query = `?token=${encodeURIComponent(issued.token)}`;
        expiresAt = issued.expiresAt;
      }
      // The sign-in page carries no credential; the others carry their token.
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
