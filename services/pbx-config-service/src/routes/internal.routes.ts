import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server, type Static } from '@cuc/http';

import type { ExtensionRepo } from '../repo/extension.repo.js';

const ParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});
const CredentialResponseSchema = Type.Object({
  extensionId: Type.String(),
  username: Type.String(),
  ha1: Type.String(),
  ha1b: Type.String(),
  realm: Type.String(),
});

/**
 * `GET /internal/v1/tenants/:tenantId/extensions/:id` (S1-12). What
 * telephony-config calls when `pbx.extension.created`/`.updated` fires, to
 * project the extension's digest credential into OpenSIPs' `subscriber`
 * table — the event itself carries only `{ extensionId, number, displayName
 * }` (06: events stay thin; a consumer that needs more state fetches it),
 * and telephony-config keeps no `sip_credentials` of its own (05 §1.1: no
 * cross-schema joins, so it either builds a read model from events or calls
 * the owner's internal API — this is the latter, same shape as
 * org-service's `/internal/v1/tenants/:id/domain`, S1-09).
 *
 * Same gating as that route: a shared `INTERNAL_SERVICE_TOKEN` bearer check
 * inside the handler rather than the `permission`/`dataClass` contract, since
 * there is no real service-to-service auth yet.
 */
export function registerInternalRoutes(
  app: Server,
  extensions: ExtensionRepo,
  internalServiceToken: string,
): void {
  app.get(
    '/internal/v1/tenants/:tenantId/extensions/:id',
    {
      config: { public: true },
      schema: { params: ParamsSchema, response: { 200: CredentialResponseSchema } },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }

      const { tenantId, id } = request.params;
      const credential = await extensions.findCredential({ tenantId }, id);
      if (credential === undefined) {
        throw ProblemError.notFound('No extension with that id in that tenant.');
      }
      return credential satisfies Static<typeof CredentialResponseSchema>;
    },
  );
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token !== undefined && token !== '' ? token : undefined;
}
