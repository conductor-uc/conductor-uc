import { ProblemError, type Server } from '@cuc/http';

import type { OrgRepo } from '../repo/org.repo.js';

const ADDRESSED_BY_ID = /^\/v1\/(resellers|tenants)\/:id(?:\/|$)/;

/**
 * Who may address an org by id (`/v1/resellers/:id/…`, `/v1/tenants/:id/…`),
 * for every such route this service has: its own org, the orgs beneath it,
 * and nothing else.
 *
 * - The master, and the platform's own tooling (service token): any.
 * - A reseller: itself, and its own tenants.
 * - A tenant: itself.
 *
 * Anyone else gets the same 404 as for an org that does not exist, so the
 * answer says nothing about which orgs there are. The route's permission is
 * still checked as before; this is the "whose" that a permission cannot say.
 * (`@cuc/http`'s tenant boundary, H2, only reads a `:tenantId` parameter, and
 * these routes name the org `:id`.)
 */
export function registerOrgOwnership(app: Server, orgs: Pick<OrgRepo, 'findById'>): void {
  app.addHook('preHandler', async (request) => {
    const match = ADDRESSED_BY_ID.exec(request.routeOptions.url ?? '');
    if (match === null) return;
    const { actorType, orgId, orgType } = request.context;
    // Unsigned requests never reach a handler here (the authentication requirement refuses them).
    if (actorType === undefined || actorType === 'service') return;
    if (orgType === 'master') return;

    const kind = match[1] as 'resellers' | 'tenants';
    const id = (request.params as { id?: string }).id;
    const refuse = () =>
      ProblemError.notFound(`No ${kind === 'resellers' ? 'reseller' : 'tenant'} with that id.`, {
        code: kind === 'resellers' ? 'reseller_not_found' : 'tenant_not_found',
      });
    if (id === undefined || orgId === undefined) throw refuse();

    if (kind === 'resellers') {
      if (orgType === 'reseller' && id === orgId) return;
      throw refuse();
    }
    if (orgType === 'tenant' && id === orgId) return;
    if (orgType === 'reseller') {
      const org = await orgs.findById(id);
      if (org?.type === 'tenant' && org.resellerId === orgId) return;
    }
    throw refuse();
  });
}
