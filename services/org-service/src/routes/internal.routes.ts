import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server, type Static } from '@cuc/http';

import type { DomainRepo } from '../repo/domain.repo.js';

const TenantParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) });
const DomainResponseSchema = Type.Object({ fqdn: Type.String() });

/**
 * `GET /internal/v1/tenants/:id/domain` (06). What pbx-config-service calls
 * to learn a tenant's current SIP realm when generating credentials (S1-09;
 * 02 §3: "Changing a tenant's primary domain invalidates stored SIP digest
 * HA1 values, which include the realm").
 *
 * Not the public `GET /v1/tenants/:id/domain` route: that one is reached
 * through api-gateway and carries a `permission`/`dataClass` contract no
 * service-to-service caller can honestly claim either side of yet (same
 * reasoning as identity-service's `/internal/v1/orgs/:orgId/admin-user`,
 * S1-05) — gated by the shared `INTERNAL_SERVICE_TOKEN` instead, checked
 * inside the handler.
 */
export function registerInternalRoutes(
  app: Server,
  domains: DomainRepo,
  internalServiceToken: string,
): void {
  app.get(
    '/internal/v1/tenants/:id/domain',
    {
      config: { public: true },
      schema: { params: TenantParamsSchema, response: { 200: DomainResponseSchema } },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }

      const domain = await domains.findPrimaryTenantDomain(request.params.id);
      if (domain === undefined) throw ProblemError.notFound('No primary domain for that tenant.');
      return { fqdn: domain.fqdn } satisfies Static<typeof DomainResponseSchema>;
    },
  );
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token !== undefined && token !== '' ? token : undefined;
}
