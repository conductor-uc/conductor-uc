import { ProblemError } from '@cuc/http';

import { OrgClientError, type OrgClient } from '../org-client.js';

/** An org a signed-in actor may manage, with what creating a user in it needs. */
export interface ManagedOrg {
  readonly orgId: string;
  readonly type: 'master' | 'reseller' | 'tenant';
  /** The reseller a tenant belongs to; null for the master and for a reseller's own users. */
  readonly resellerId: string | null;
}

/** The parts of a request context that decide what an actor may reach. */
export interface ActorContext {
  readonly orgId?: string | undefined;
  readonly orgType?: 'master' | 'reseller' | 'tenant' | undefined;
  readonly resellerId?: string | undefined;
}

export interface OrgAccess {
  /**
   * The org the actor asked to manage, if they may. An actor may manage their
   * own org; the master may manage any; a reseller may manage its own tenants;
   * a tenant only its own. Anything else is refused the same way whether or
   * not the org exists, so the answer says nothing about which orgs there are.
   */
  resolve(actor: ActorContext, targetOrgId: string): Promise<ManagedOrg>;
}

export function createOrgAccess(orgs: Pick<OrgClient, 'lineage'>): OrgAccess {
  const refused = () =>
    ProblemError.forbidden('You cannot manage people in that organization.', {
      code: 'users_other_org',
    });

  return {
    async resolve(actor, targetOrgId) {
      const { orgId, orgType } = actor;
      if (orgId === undefined || orgType === undefined) {
        throw ProblemError.unauthorized('Sign in to manage users.');
      }
      if (targetOrgId === orgId) {
        return {
          orgId,
          type: orgType,
          resellerId: orgType === 'tenant' ? (actor.resellerId ?? null) : null,
        };
      }
      // A tenant has nothing beneath it, so there is nothing to look up.
      if (orgType === 'tenant') throw refused();

      let lineage;
      try {
        lineage = await orgs.lineage(targetOrgId);
      } catch (error) {
        if (error instanceof OrgClientError) {
          throw new ProblemError(
            503,
            '/problems/unavailable',
            'Service unavailable',
            'org_lookup_unavailable',
            { detail: 'Could not check that organization. Try again shortly.' },
          );
        }
        throw error;
      }
      if (lineage === undefined) throw refused();
      const beneathActor =
        orgType === 'master' || (lineage.type === 'tenant' && lineage.resellerId === orgId);
      if (!beneathActor) throw refused();
      return {
        orgId: lineage.orgId,
        type: lineage.type,
        resellerId: lineage.type === 'tenant' ? lineage.resellerId : null,
      };
    },
  };
}
