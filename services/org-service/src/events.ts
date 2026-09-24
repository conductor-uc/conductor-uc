import { Type, defineEvents } from '@cuc/api-contracts';

/**
 * org-service's event contracts.
 *
 * The entity segment of the subject is the org's *type*, matching the
 * documented consumers in 05 §5 ("telephony-config consumes org.tenant.*").
 * There is no `org.master.created`: the master is created once, by bootstrap,
 * outside any transaction a consumer could usefully react to, and nothing in
 * the catalog consumes it.
 *
 * Subjects are validated at registration, so a typo fails at startup rather
 * than at first publish.
 */
export const orgEvents = defineEvents({
  'org.reseller.created': {
    schemaVersion: 1,
    description: 'A reseller org was created under the master.',
    data: Type.Object({
      orgId: Type.String({ minLength: 1 }),
      slug: Type.String({ minLength: 1 }),
      name: Type.String({ minLength: 1 }),
      parentId: Type.String({ minLength: 1 }),
    }),
  },
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
  'org.reseller.updated': {
    schemaVersion: 1,
    description: "A reseller's name, timezone, country, or limits changed.",
    data: Type.Object({ orgId: Type.String({ minLength: 1 }) }),
  },
  'org.tenant.updated': {
    schemaVersion: 1,
    description: "A tenant's name, timezone, country, or limits changed.",
    data: Type.Object({ orgId: Type.String({ minLength: 1 }) }),
  },
  'org.reseller.suspended': {
    schemaVersion: 1,
    description: 'A reseller was suspended, along with all of its tenants (02 §2).',
    data: Type.Object({ orgId: Type.String({ minLength: 1 }) }),
  },
  'org.reseller.resumed': {
    schemaVersion: 1,
    description: 'A suspended reseller was returned to active.',
    data: Type.Object({ orgId: Type.String({ minLength: 1 }) }),
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
      /** The tenant id for `scope: 'tenant'`, the reseller id for `scope: 'reseller_base'`. */
      ownerId: Type.String({ minLength: 1 }),
    }),
  },
  'org.certificate.issued': {
    schemaVersion: 1,
    description:
      'A TLS certificate was issued or renewed for a hostname (G-105). Carries no key: a ' +
      'consumer that needs the certificate and key asks org-service for them.',
    data: Type.Object({
      fqdn: Type.String({ minLength: 1 }),
      purpose: Type.Union([Type.Literal('sip'), Type.Literal('console')]),
      /** The reseller it belongs to; null for the platform's own. */
      resellerId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      version: Type.Integer({ minimum: 1 }),
    }),
  },
  'org.brand.updated': {
    schemaVersion: 1,
    description: "A reseller's brand (colors, assets, support info, …) changed (02 §5.4).",
    data: Type.Object({ resellerId: Type.String({ minLength: 1 }) }),
  },
});
