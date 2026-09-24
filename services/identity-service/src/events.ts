import { Type, defineEvents } from '@cuc/api-contracts';

/**
 * identity-service's event contracts.
 *
 * `identity.user.created`, plus the two token-carrying events S3-04 adds.
 * Earlier: only `identity.user.created`: it is the only lifecycle event this
 * task's code actually publishes. `identity.user.updated|disabled|deleted`
 * and `identity.grant.changed` are named in 06's catalog for the service as a
 * whole, but nothing here produces them yet — they arrive with the user CRUD
 * and grants work in later tasks, not invented ahead of a publisher.
 */
export const identityEvents = defineEvents({
  'identity.user.created': {
    schemaVersion: 1,
    description: "A user was created — for now, always an org's first admin.",
    data: Type.Object({
      userId: Type.String({ minLength: 1 }),
      orgId: Type.String({ minLength: 1 }),
      email: Type.String({ minLength: 1 }),
    }),
  },
  'identity.user.updated': {
    schemaVersion: 1,
    description:
      "A user's display name or status changed. A user who was disabled has had every " +
      'session revoked.',
    data: Type.Object({
      userId: Type.String({ minLength: 1 }),
      orgId: Type.String({ minLength: 1 }),
      status: Type.Union([Type.Literal('active'), Type.Literal('disabled')]),
    }),
  },
  'identity.user.mfa_reset': {
    schemaVersion: 1,
    description:
      "An admin reset a user's two-step verification: their authenticator was removed and " +
      'every session revoked, so they enroll a new one at the next sign-in. notification-service ' +
      'emails the user. Carries no secret.',
    data: Type.Object({
      userId: Type.String({ minLength: 1 }),
      orgId: Type.String({ minLength: 1 }),
      email: Type.String({ minLength: 1 }),
      displayName: Type.String({ minLength: 1 }),
    }),
  },
  'identity.user.password_reset_requested': {
    schemaVersion: 1,
    description:
      'A password reset was requested for an active user. Carries the one-time token ' +
      "notification-service emails; it is a secret, so this event's subscribers are " +
      'limited to that delivery path (G-55).',
    data: Type.Object({
      userId: Type.String({ minLength: 1 }),
      orgId: Type.String({ minLength: 1 }),
      email: Type.String({ minLength: 1 }),
      token: Type.String({ minLength: 1 }),
      expiresAt: Type.String({ minLength: 1 }),
    }),
  },
  'identity.invitation.created': {
    schemaVersion: 1,
    description:
      'A user was invited to an org. Carries the one-time acceptance token ' +
      'notification-service emails (G-55).',
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
