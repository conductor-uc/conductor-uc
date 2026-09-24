import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server, type Static } from '@cuc/http';

import type { CallHandlingRepo } from '../repo/call-handling.repo.js';
import { CallHandlingSchema } from './call-handling.routes.js';

const ParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});
const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });

const RowSchema = Type.Object({ extensionId: Type.String(), ...CallHandlingSchema.properties });

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' ? token : undefined;
}

/**
 * telephony-config's two reads of call handling (parity 1a), service-token
 * authenticated like this service's other internal routes:
 *
 *  - `GET /internal/v1/tenants/:tenantId/extensions/:id/call-handling`, what
 *    its `pbx.call_handling.updated` consumer re-fetches (a thin
 *    event); 404 when nothing is configured for that extension, which the
 *    consumer takes to mean "clear the mirror".
 *  - `GET /internal/v1/tenants/:tenantId/call-handling`, every configured
 *    extension in the tenant, for its reconciliation pass (a missed event
 *    heals on the next one).
 */
export function registerCallHandlingInternalRoutes(
  app: Server,
  callHandling: CallHandlingRepo,
  internalServiceToken: string,
): void {
  function authorize(header: string | undefined): void {
    const presented = bearerToken(header);
    if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
      throw ProblemError.unauthorized('A valid internal service token is required.');
    }
  }

  app.get(
    '/internal/v1/tenants/:tenantId/extensions/:id/call-handling',
    {
      config: { public: true },
      schema: { params: ParamsSchema, response: { 200: CallHandlingSchema } },
    },
    async (request) => {
      authorize(request.headers.authorization);
      const { tenantId, id } = request.params;
      const found = await callHandling.find({ tenantId }, id);
      if (found === undefined) {
        throw ProblemError.notFound('No call handling is configured for that extension.');
      }
      return found as unknown as Static<typeof CallHandlingSchema>;
    },
  );

  app.get(
    '/internal/v1/tenants/:tenantId/call-handling',
    {
      config: { public: true },
      schema: {
        params: TenantParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(RowSchema) }) },
      },
    },
    async (request) => {
      authorize(request.headers.authorization);
      const rows = await callHandling.listForTenant({ tenantId: request.params.tenantId });
      return {
        rows: rows.map((r) => ({ extensionId: r.extensionId, ...r.handling })) as unknown as Static<
          typeof RowSchema
        >[],
      };
    },
  );
}
