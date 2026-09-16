import { Type, defineEvents } from '@cuc/api-contracts';

/**
 * This service's event contracts (06's trunk-service section:
 * `trunk.trunk.created|updated|deleted`; S2-04 adds
 * `trunk.outbound_route.created|updated|deleted`; S2-06 adds
 * `trunk.emergency_route.created|updated|deleted`, the same thin-event shape).
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
  'trunk.outbound_route.created': {
    schemaVersion: 1,
    description: 'An outbound route was created for a tenant.',
    data: Type.Object({ outboundRouteId: Type.String({ minLength: 1 }) }),
  },
  'trunk.outbound_route.updated': {
    schemaVersion: 1,
    description: "An outbound route's pattern, trunk list, strip, or prepend changed.",
    data: Type.Object({ outboundRouteId: Type.String({ minLength: 1 }) }),
  },
  'trunk.outbound_route.deleted': {
    schemaVersion: 1,
    description: 'An outbound route was deleted.',
    data: Type.Object({ outboundRouteId: Type.String({ minLength: 1 }) }),
  },
  'trunk.emergency_route.created': {
    schemaVersion: 1,
    description: "A tenant's emergency route was created (S2-06; G-1).",
    data: Type.Object({ emergencyRouteId: Type.String({ minLength: 1 }) }),
  },
  'trunk.emergency_route.updated': {
    schemaVersion: 1,
    description: "An emergency route's trunk or number list changed.",
    data: Type.Object({ emergencyRouteId: Type.String({ minLength: 1 }) }),
  },
  'trunk.emergency_route.deleted': {
    schemaVersion: 1,
    description: 'An emergency route was deleted.',
    data: Type.Object({ emergencyRouteId: Type.String({ minLength: 1 }) }),
  },
});
