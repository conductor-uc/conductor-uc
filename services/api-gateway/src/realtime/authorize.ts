import { h1RouteLevelWall } from '@cuc/authz';
import type { PermissionResolver } from '@cuc/http';

import type { ErrorCode } from './protocol.js';
import type { LineageLookup } from './sources.js';
import { TOPICS, type Topic } from './topics.js';

/** The signed-in person behind a connection, from their verified access token. */
export interface RealtimeActor {
  readonly id: string;
  readonly orgId: string;
  readonly orgType: 'master' | 'reseller' | 'tenant';
}

export type AuthorizeResult =
  { readonly allowed: true } | { readonly allowed: false; readonly code: ErrorCode };

export interface TopicAuthorizer {
  authorize(actor: RealtimeActor, topic: Topic): Promise<AuthorizeResult>;
}

/**
 * Decides whether a person may receive a topic, with the rules every HTTP route
 * gets from `@cuc/http` (07 §3.1), in the same order:
 *
 * 1. **Org ancestry, with H2.** A tenant's people reach only their own tenant;
 *    a reseller's reach its own tenants (asked of org-service, since the token
 *    says only the person's own org); the master's reach every tenant. A
 *    person's own topic (`user:{u}:calls`, S5-15) is reached by that person
 *    alone.
 * 2. **H1.** A reseller never receives a `private` topic, whatever it holds.
 * 3. **The topic's permission**, through the same identity-service lookup the
 *    services' permission guard uses (`createRemotePermissionResolver`: a role
 *    or an org-wide grant, `.manage` implying `.read`).
 *
 * A lookup that fails answers `unavailable`, never "allowed": it fails closed.
 */
export function createTopicAuthorizer(options: {
  readonly permissions: PermissionResolver;
  readonly lineage: LineageLookup;
}): TopicAuthorizer {
  return {
    async authorize(actor, topic) {
      const definition = TOPICS[topic.kind];
      try {
        if (!(await reaches(actor, topic.tenantId))) return { allowed: false, code: 'forbidden' };
        // S5-15: a person's own calls are theirs alone ("this is me"): a person of that tenant
        // whose id is the topic's. Not the master, not an administrator, not a colleague.
        if (
          topic.userId !== undefined &&
          (actor.orgType !== 'tenant' || actor.id !== topic.userId)
        ) {
          return { allowed: false, code: 'forbidden' };
        }
        if (!h1RouteLevelWall(actor.orgType, definition.dataClass)) {
          return { allowed: false, code: 'reseller_private_data_denied' };
        }
        if (!(await options.permissions(actor, definition.permission))) {
          return { allowed: false, code: 'permission_denied' };
        }
        return { allowed: true };
      } catch {
        return { allowed: false, code: 'unavailable' };
      }
    },
  };

  async function reaches(actor: RealtimeActor, tenantId: string): Promise<boolean> {
    switch (actor.orgType) {
      case 'master':
        return true;
      case 'tenant':
        return actor.orgId === tenantId;
      case 'reseller': {
        const lineage = await options.lineage(tenantId);
        return lineage?.type === 'tenant' && lineage.resellerId === actor.orgId;
      }
    }
  }
}
