import type { Server } from '@cuc/http';

import { buildJwks } from '../tokens/jwks.js';
import type { SigningKeyRepo } from '../repo/signing-key.repo.js';

/**
 * `GET /.well-known/jwks.json` (06, RFC 8615). Public by nature — it exists to
 * let anyone verify a token this service signed — so `public: true` is the
 * correct declaration, the same as `/healthz` and `/openapi.json`.
 */
export function registerJwksRoute(
  app: Server,
  signingKeys: SigningKeyRepo,
  overlapDays: number,
): void {
  app.get('/.well-known/jwks.json', { config: { public: true } }, async () =>
    buildJwks(await signingKeys.forVerification(overlapDays)),
  );
}
