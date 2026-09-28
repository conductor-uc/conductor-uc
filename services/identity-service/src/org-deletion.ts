import type { Database, Transaction } from '@cuc/db';
import { createOrgDeletedConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import { identityEvents } from './events.js';
import type { IdentityServiceDb } from './schema.js';

/**
 * Removes a deleted org's people and access (S1-16, G-11 (3)): its users with
 * their sessions, two-step factors and reset links, its custom roles, role
 * assignments and grants, its invitations and API keys. The same for a tenant
 * or a reseller: these tables are keyed by `org_id`, whatever kind of org it
 * is. The audit trail stays (G-11 (5)); audit retention removes it later.
 */
export async function purgeOrg(trx: Transaction<IdentityServiceDb>, orgId: string): Promise<void> {
  const users = trx.selectFrom('users').select('id').where('org_id', '=', orgId);
  const roles = trx.selectFrom('roles').select('id').where('org_id', '=', orgId);
  await trx.deleteFrom('sessions').where('user_id', 'in', users).execute();
  await trx.deleteFrom('mfa_factors').where('user_id', 'in', users).execute();
  await trx.deleteFrom('password_reset_tokens').where('user_id', 'in', users).execute();
  await trx.deleteFrom('role_assignments').where('scope_org_id', '=', orgId).execute();
  await trx.deleteFrom('role_assignments').where('user_id', 'in', users).execute();
  await trx.deleteFrom('role_permissions').where('role_id', 'in', roles).execute();
  await trx.deleteFrom('grants').where('org_id', '=', orgId).execute();
  await trx.deleteFrom('roles').where('org_id', '=', orgId).execute();
  await trx.deleteFrom('invitations').where('org_id', '=', orgId).execute();
  await trx.deleteFrom('api_keys').where('org_id', '=', orgId).execute();
  await trx.deleteFrom('users').where('org_id', '=', orgId).execute();
}

/** S1-16: `org.*.deleted`, handled once per org (`identity-service-org-deleted`). */
export function createOrgDeletionConsumer(
  db: Database<IdentityServiceDb>,
  bus: Bus,
  logger: Logger,
  options: { readonly pullTimeoutMs?: number } = {},
): EventConsumer {
  return createOrgDeletedConsumer<IdentityServiceDb>({
    db: db.kysely,
    bus,
    logger,
    registry: identityEvents,
    durable: 'identity-service-org-deleted',
    tenant: purgeOrg,
    reseller: purgeOrg,
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
  });
}
