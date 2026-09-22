import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server } from '@cuc/http';

import type { FlowRepo } from '../repo/flow.repo.js';

const ParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});

/**
 * `GET /internal/v1/tenants/:tenantId/flows/:id/ir` (S2-09) — the internal IR
 * endpoint the plan calls for: how S2-10's `flow_runner.lua` (via mod_curl)
 * fetches a flow's *currently published* compiled IR. Same gating as every
 * other internal route in this codebase (07 §1 precedent, pbx-config-service's
 * own `internal.routes.ts`): a shared `INTERNAL_SERVICE_TOKEN` bearer check
 * inside the handler, not the `permission`/`dataClass` contract, since there
 * is no real service-to-service auth yet.
 *
 * Returns 404 when the flow has never published — flow_runner's own job to
 * decide what "no flow to run" means for a call, not this service's.
 *
 * The response wraps the IR in its version identity (`versionId`,
 * `versionNumber`) rather than returning the bare IR: the runner caches the
 * IR on local disk and needs something to key that cache on that changes on
 * every `:publish`, or a newly published version would not take effect until
 * the node restarted (S2-10's own "Done when" requires it take effect on the
 * *next call*).
 */
export function registerInternalRoutes(
  app: Server,
  flows: FlowRepo,
  internalServiceToken: string,
): void {
  app.get(
    '/internal/v1/tenants/:tenantId/flows/:id/ir',
    { config: { public: true }, schema: { params: ParamsSchema } },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }

      const { tenantId, id } = request.params;
      const published = await flows.findPublishedIrWithVersion({ tenantId }, id);
      if (published === undefined) {
        throw ProblemError.notFound('No published version for that flow in that tenant.');
      }
      return published;
    },
  );
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token !== undefined && token !== '' ? token : undefined;
}
