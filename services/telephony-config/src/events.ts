import { Type, defineEvents } from '@cuc/api-contracts';

/**
 * Event contracts this service consumes (S1-12; 05 §5: "telephony-config
 * consumes org.tenant.*, org.domain.*, pbx.*, trunk.*,
 * callflow.flow.published, recording.policy.*"). Only the ones a producer
 * actually emits today are registered — `trunk.*`, `callflow.flow.published`,
 * and `recording.policy.*` have no owning service yet (trunk-service is
 * S2-01, callflow-service S2, recording-service S5) and there is nothing on
 * those subjects to consume until then.
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
});
