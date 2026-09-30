import { ORG_DELETED_EVENTS } from '@cuc/events';
import { Type, defineEvents } from '@cuc/api-contracts';

/**
 * Event contracts this service consumes (06: notification-service "consumes
 * the events listed in 05 §5"; the identity ones that need an
 * email, and voicemail-service's new-message event). Copied from identity-service rather than imported — services do not
 * import each other's source (05 §1.1) — so a schema change there needs the
 * same change here.
 *
 * None of them carries a credential. The reset and invitation events carry
 * ids only (G-55, version 2): the one-time token is issued by identity-service
 * when this service sends the email (`identity-client.ts`).
 */
export const notificationEvents = defineEvents({
  // S1-16 (G-11): org-service's deletions, which this service acts on.
  ...ORG_DELETED_EVENTS,
  'identity.user.password_reset_requested': {
    schemaVersion: 2,
    description:
      'A password reset was requested for an active user. Carries no token; the link is issued at send time.',
    data: Type.Object(
      {
        resetId: Type.String({ minLength: 1 }),
        userId: Type.String({ minLength: 1 }),
        orgId: Type.String({ minLength: 1 }),
        email: Type.String({ minLength: 1 }),
        expiresAt: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  'identity.user.mfa_reset': {
    schemaVersion: 1,
    description: "An admin reset a user's two-step verification. Carries no secret.",
    data: Type.Object({
      userId: Type.String({ minLength: 1 }),
      orgId: Type.String({ minLength: 1 }),
      email: Type.String({ minLength: 1 }),
      displayName: Type.String({ minLength: 1 }),
    }),
  },
  'identity.invitation.created': {
    schemaVersion: 2,
    description: 'A user was invited to an org. Carries no token; the link is issued at send time.',
    data: Type.Object(
      {
        invitationId: Type.String({ minLength: 1 }),
        orgId: Type.String({ minLength: 1 }),
        orgType: Type.String({ minLength: 1 }),
        resellerId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
        email: Type.String({ minLength: 1 }),
        displayName: Type.String({ minLength: 1 }),
        expiresAt: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  'voicemail.message.created': {
    schemaVersion: 1,
    description:
      'A voicemail message finished uploading. Thin by design: the caller, time and audio are private-class data, so the consumer reads them from voicemail-service.',
    data: Type.Object({
      messageId: Type.String({ minLength: 1 }),
      mailboxId: Type.String({ minLength: 1 }),
    }),
  },
  /** Mirrors telephony-config's contract (S2-06, G-1): someone in the tenant dialled an emergency number. */
  'call.emergency.initiated': {
    schemaVersion: 1,
    description: 'A call to a tenant emergency number was dialplan-resolved and bridged.',
    data: Type.Object({
      dialedNumber: Type.String({ minLength: 1 }),
      callingExtensionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      emergencyLocationId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      callingNumber: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
      callingName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      location: Type.Optional(
        Type.Union([
          Type.Object({
            label: Type.String(),
            addressLine1: Type.String(),
            addressLine2: Type.Union([Type.String(), Type.Null()]),
            city: Type.String(),
            state: Type.String(),
            postalCode: Type.String(),
            country: Type.String(),
          }),
          Type.Null(),
        ]),
      ),
    }),
  },
});
