import { Type, defineEvents } from '@cuc/api-contracts';

/**
 * Event contracts this service consumes (06: notification-service "consumes
 * the events listed in 05 §5"; today, the two identity ones that need an
 * email). Copied from identity-service rather than imported — services do not
 * import each other's source (05 §1.1) — so a schema change there needs the
 * same change here.
 *
 * The reset and invitation events carry a one-time token, which is a
 * credential (G-55); the MFA-reset event carries none.
 */
export const notificationEvents = defineEvents({
  'identity.user.password_reset_requested': {
    schemaVersion: 1,
    description: 'A password reset was requested for an active user.',
    data: Type.Object({
      userId: Type.String({ minLength: 1 }),
      orgId: Type.String({ minLength: 1 }),
      email: Type.String({ minLength: 1 }),
      token: Type.String({ minLength: 1 }),
      expiresAt: Type.String({ minLength: 1 }),
    }),
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
    schemaVersion: 1,
    description: 'A user was invited to an org.',
    data: Type.Object({
      invitationId: Type.String({ minLength: 1 }),
      orgId: Type.String({ minLength: 1 }),
      orgType: Type.String({ minLength: 1 }),
      resellerId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      email: Type.String({ minLength: 1 }),
      displayName: Type.String({ minLength: 1 }),
      token: Type.String({ minLength: 1 }),
      expiresAt: Type.String({ minLength: 1 }),
    }),
  },
});
