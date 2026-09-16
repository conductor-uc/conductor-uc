import { Type, defineEvents } from '@cuc/api-contracts';

/**
 * Event contracts this service consumes (S1-12; 05 §5: "telephony-config
 * consumes org.tenant.*, org.domain.*, pbx.*, trunk.*,
 * callflow.flow.published, recording.policy.*"). Only the ones a producer
 * actually emits today are registered — `trunk.*` joined S2-02, once
 * trunk-service (S2-01) existed to emit it; `callflow.flow.published` and
 * `recording.policy.*` still have no owning service (callflow-service S2,
 * recording-service S5) and there is nothing on those subjects to consume
 * until then.
 *
 * `org.tenant.updated` is deliberately not registered: nothing it carries
 * (name, timezone, country, limits) affects the `opensips` projection this
 * service owns, so there would be nothing for a handler to do.
 *
 * Copied here rather than imported from org-service/pbx-config-service —
 * services do not import each other's source (05 §1.1) — so a schema
 * change in the owning service needs the same bump made here too, the
 * ordinary dual-publish discipline 05 §5 already asks of every event change.
 */
export const telephonyEvents = defineEvents({
  'org.tenant.created': {
    schemaVersion: 1,
    description: 'A tenant org was created under a reseller.',
    data: Type.Object({
      orgId: Type.String({ minLength: 1 }),
      slug: Type.String({ minLength: 1 }),
      name: Type.String({ minLength: 1 }),
      parentId: Type.String({ minLength: 1 }),
    }),
  },
  'org.tenant.suspended': {
    schemaVersion: 1,
    description:
      'A tenant was suspended: console login, SIP registration, and calls for its domain ' +
      'are rejected. Data is retained (02 §2).',
    data: Type.Object({ orgId: Type.String({ minLength: 1 }) }),
  },
  'org.tenant.resumed': {
    schemaVersion: 1,
    description: 'A suspended tenant was returned to active.',
    data: Type.Object({ orgId: Type.String({ minLength: 1 }) }),
  },
  'org.domain.added': {
    schemaVersion: 1,
    description:
      'A domain became active: a tenant got its primary SIP domain, or a reseller base ' +
      'domain finished TXT verification (02 §3).',
    data: Type.Object({
      domainId: Type.String({ minLength: 1 }),
      fqdn: Type.String({ minLength: 1 }),
      scope: Type.Union([Type.Literal('tenant'), Type.Literal('reseller_base')]),
      ownerId: Type.String({ minLength: 1 }),
    }),
  },
  'pbx.extension.created': {
    schemaVersion: 1,
    description: 'An extension was created, with SIP credentials generated for it.',
    data: Type.Object({
      extensionId: Type.String({ minLength: 1 }),
      number: Type.String({ minLength: 1 }),
      displayName: Type.String({ minLength: 1 }),
    }),
  },
  'pbx.extension.updated': {
    schemaVersion: 1,
    description: "An extension's number, display name, caller id, or voicemail setting changed.",
    data: Type.Object({ extensionId: Type.String({ minLength: 1 }) }),
  },
  'pbx.extension.deleted': {
    schemaVersion: 1,
    description: 'An extension (and its SIP credentials) was deleted.',
    data: Type.Object({ extensionId: Type.String({ minLength: 1 }) }),
  },
  'pbx.did.created': {
    schemaVersion: 1,
    description: 'A DID was created and bound to a trunk and a destination.',
    data: Type.Object({
      didId: Type.String({ minLength: 1 }),
      e164: Type.String({ minLength: 1 }),
    }),
  },
  'pbx.did.updated': {
    schemaVersion: 1,
    description: "A DID's trunk binding or destination changed.",
    data: Type.Object({ didId: Type.String({ minLength: 1 }) }),
  },
  'pbx.did.deleted': {
    schemaVersion: 1,
    description: 'A DID was deleted.',
    data: Type.Object({ didId: Type.String({ minLength: 1 }) }),
  },
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
  /**
   * S2-06 (G-1: "a notification hook (email/SMS/console) on every emergency
   * call") — published by this service itself, the first event it ever
   * originates rather than just consumes, from `/fs/dialplan`'s emergency
   * branch at the moment a call to one of the tenant's emergency numbers is
   * dialplan-resolved. `call`, not a new `emergency` domain:
   * `@cuc/api-contracts`' `EVENT_DOMAINS` is a closed list with no such
   * domain, and `call.lost`'s own precedent there is exactly this shape —
   * something that happened during a call, not a CRUD entity. No consumer
   * exists yet for the actual email/SMS/console delivery (a future stage's
   * job, docs/decisions.md gap) — this is the hook itself.
   */
  'call.emergency.initiated': {
    schemaVersion: 1,
    description: 'A call to a tenant emergency number was dialplan-resolved and bridged.',
    data: Type.Object({
      dialedNumber: Type.String({ minLength: 1 }),
      callingExtensionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      emergencyLocationId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    }),
  },
});
