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
});
