import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server } from '@cuc/http';

import type { PresenceWatcher } from '../presence.js';

const ParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1, maxLength: 64 }) });

const ResponseSchema = Type.Object({
  extensions: Type.Array(
    Type.Object({
      extensionId: Type.String(),
      extension: Type.String(),
      registered: Type.Boolean(),
      dnd: Type.Boolean(),
    }),
  ),
});

/**
 * `GET /internal/v1/tenants/:tenantId/presence` (S5-10, G-122): every extension of the tenant, with
 * whether a phone is registered for it and whether it is set to do not disturb, as last announced
 * in `call.presence.changed`. api-gateway's realtime hub asks it for the presence topic's snapshot
 * and follows the events after it. Gated by the shared internal service token, like this
 * service's other internal routes.
 */
export function registerPresenceRoutes(
  app: Server,
  deps: { readonly presence: PresenceWatcher; readonly internalServiceToken: string },
): void {
  app.get(
    '/internal/v1/tenants/:tenantId/presence',
    {
      config: { public: true },
      schema: { params: ParamsSchema, response: { 200: ResponseSchema } },
    },
    async (request) => {
      const [scheme, presented] = request.headers.authorization?.split(' ') ?? [];
      if (
        scheme !== 'Bearer' ||
        presented === undefined ||
        !secretEquals(deps.internalServiceToken, presented)
      ) {
        throw ProblemError.unauthorized('A valid internal service token is required.', {
          code: 'internal_token_invalid',
        });
      }
      return { extensions: await deps.presence.forTenant(request.params.tenantId) };
    },
  );
}
