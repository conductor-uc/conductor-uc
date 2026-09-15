import { Type, defineEvents } from '@cuc/api-contracts';

/**
 * This service's event contracts (06's trunk-service section:
 * `trunk.trunk.created|updated|deleted`). `trunk.route.changed` belongs to
 * outbound-route management (S2-04), not S2-01, so it is not declared here
 * yet — added when that task actually emits it.
 */
export const trunkEvents = defineEvents({
  'trunk.trunk.created': {
    schemaVersion: 1,
    description: 'A trunk was created for a tenant.',
    data: Type.Object({
      trunkId: Type.String({ minLength: 1 }),
      name: Type.String({ minLength: 1 }),
      authMode: Type.Union([Type.Literal('register'), Type.Literal('ip'), Type.Literal('both')]),
    }),
  },
  'trunk.trunk.updated': {
    schemaVersion: 1,
    description: "A trunk's configuration changed (fields, IPs, or credentials).",
    data: Type.Object({ trunkId: Type.String({ minLength: 1 }) }),
  },
  'trunk.trunk.deleted': {
    schemaVersion: 1,
    description: 'A trunk was deleted.',
    data: Type.Object({ trunkId: Type.String({ minLength: 1 }) }),
  },
});
