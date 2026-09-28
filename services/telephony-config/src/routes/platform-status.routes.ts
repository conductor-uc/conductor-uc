import { secretEquals } from '@cuc/crypto';
import { ProblemError, type Server } from '@cuc/http';

import type { PlatformStatus } from '../platform-status.js';

/**
 * `GET /internal/v1/platform/status` (S4-12): the SIP edge, the FS pool as OpenSIPs holds it,
 * and MariaDB (`platform-status.ts`), for api-gateway's `GET /v1/platform/overview`. Gated by the
 * shared internal service token, like this service's other internal routes. Nothing in it is a
 * tenant's: counts, sizes and addresses of the platform's own servers.
 */
export function registerPlatformStatusRoutes(
  app: Server,
  deps: {
    readonly status: { read(): Promise<PlatformStatus> };
    readonly internalServiceToken: string;
  },
): void {
  app.get('/internal/v1/platform/status', { config: { public: true } }, async (request) => {
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
    return deps.status.read();
  });
}
