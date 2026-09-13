import { Type, defineEvents } from '@cuc/api-contracts';

/**
 * identity-service's event contracts.
 *
 * Only `identity.user.created` so far: it is the only lifecycle event this
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
});
