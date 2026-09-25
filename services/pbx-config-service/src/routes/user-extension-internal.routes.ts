import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server } from '@cuc/http';

import type { ExtensionRepo } from '../repo/extension.repo.js';

const ParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  userId: Type.String({ minLength: 1 }),
});

/**
 * `GET /internal/v1/tenants/:tenantId/users/:userId/extension`: which extension
 * belongs to a person (parity 1e), for voicemail-service and cdr-service. Their
 * self-service routes learn "my extension" from here, from the signed actor id,
 * so they never trust an extension id from a client. Service-token gated like
 * this service's other internal routes; 404 when the person has none.
 */
export function registerUserExtensionInternalRoutes(
  app: Server,
  extensions: ExtensionRepo,
  internalServiceToken: string,
): void {
  app.get(
    '/internal/v1/tenants/:tenantId/users/:userId/extension',
    {
      config: { public: true },
      schema: {
        params: ParamsSchema,
        response: { 200: Type.Object({ extensionId: Type.String(), number: Type.String() }) },
      },
    },
    async (request) => {
      const header = request.headers.authorization;
      const [scheme, presented] = header?.split(' ') ?? [];
      if (
        scheme !== 'Bearer' ||
        presented === undefined ||
        !secretEquals(internalServiceToken, presented)
      ) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }
      const found = await extensions.findByUserId(
        { tenantId: request.params.tenantId },
        request.params.userId,
      );
      if (found === undefined) throw ProblemError.notFound('No extension is linked to that user.');
      return { extensionId: found.id, number: found.number };
    },
  );
}
