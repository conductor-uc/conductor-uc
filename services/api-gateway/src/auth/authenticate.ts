import { ProblemError } from '@cuc/http';
import type { Server } from '@cuc/http';

import type { AccessTokenVerifier } from './access-token-verifier.js';
import { InvalidApiKeyError, type ApiKeyVerifier } from './api-key-verifier.js';
import { InvalidAccessTokenError } from './access-token-verifier.js';
import { isPublicPath } from '../routing/route-table.js';

export interface AuthenticationOptions {
  readonly verifier: AccessTokenVerifier;
  /**
   * S1-08 (G-14): verifies `Authorization: Bearer key_…` (or `ApiKey key_…`).
   * Absent when the gateway has no `INTERNAL_SERVICE_TOKEN` to ask
   * identity-service with; a key is then answered 503.
   */
  readonly apiKeys?: ApiKeyVerifier;
  readonly publicPrefixes: readonly string[];
  /**
   * Exact paths that authenticate on their own, after this hook: the realtime
   * hub's `/v1/ws`, whose token arrives in the first WebSocket message because
   * a browser cannot send it as a header (`realtime/route.ts`).
   */
  readonly selfAuthenticatingPaths?: readonly string[];
}

/**
 * `x-internal-*` headers are the *output* of this hook (built downstream, in
 * `registerProxy`), never an input to it — an external client's own copy of
 * them is inert here, since `request.context` was already built by
 * `@cuc/http` with `trustInternalHeaders` off for this service.
 */
export function registerAuthentication(app: Server, options: AuthenticationOptions): void {
  app.addHook('preHandler', async (request) => {
    if (!request.url.startsWith('/v1/')) return;
    // A CORS preflight carries no Authorization header by construction — the
    // browser sends it unauthenticated to ask "may I?" before the real
    // request. It is answered entirely by registerCors's own route.
    if (request.method === 'OPTIONS') return;

    const path = new URL(request.url, 'http://internal').pathname;
    if (isPublicPath(options.publicPrefixes, path)) return;
    if (options.selfAuthenticatingPaths?.includes(path) === true) return;

    const header = request.headers.authorization;
    if (header === undefined) {
      throw ProblemError.unauthorized('Authentication required.', {
        code: 'authentication_required',
      });
    }

    const [scheme, credential] = splitScheme(header);

    // An API key (07 §1): `key_<id>_<secret>`, sent as a bearer credential.
    if (
      (scheme === 'bearer' || scheme === 'apikey') &&
      credential !== undefined &&
      credential.startsWith('key_')
    ) {
      if (options.apiKeys === undefined) {
        throw ProblemError.unavailable('API keys cannot be checked right now.', {
          code: 'api_key_check_unavailable',
        });
      }
      let key;
      try {
        key = await options.apiKeys.verify(credential);
      } catch (error) {
        if (error instanceof InvalidApiKeyError) {
          throw ProblemError.unauthorized('The API key is invalid, revoked or expired.', {
            code: 'api_key_invalid',
          });
        }
        throw error;
      }
      request.context = {
        ...request.context,
        actorId: key.keyId,
        actorType: 'apikey',
        orgId: key.orgId,
        orgType: key.orgType,
        ...(key.resellerId === null ? {} : { resellerId: key.resellerId }),
        ...(key.orgType === 'tenant' ? { tenantId: key.orgId } : {}),
      };
      return;
    }

    if (scheme === 'bearer' && credential !== undefined) {
      let claims;
      try {
        claims = await options.verifier.verify(credential);
      } catch (error) {
        if (error instanceof InvalidAccessTokenError) {
          throw ProblemError.unauthorized('The access token is invalid or expired.', {
            code: 'access_token_invalid',
          });
        }
        throw error;
      }

      request.context = {
        ...request.context,
        actorId: claims.sub,
        actorType: 'user',
        orgId: claims.org,
        orgType: claims.ot,
        ...(claims.rsl === undefined ? {} : { resellerId: claims.rsl }),
        ...(claims.ot === 'tenant' ? { tenantId: claims.org } : {}),
      };
      return;
    }

    if (scheme === 'apikey') {
      throw ProblemError.unauthorized('The API key is invalid, revoked or expired.', {
        code: 'api_key_invalid',
      });
    }

    throw ProblemError.unauthorized('Unrecognised authentication scheme.', {
      code: 'auth_scheme_unsupported',
    });
  });
}

function splitScheme(header: string): [string, string | undefined] {
  const spaceIndex = header.indexOf(' ');
  if (spaceIndex === -1) return [header.toLowerCase(), undefined];
  return [header.slice(0, spaceIndex).toLowerCase(), header.slice(spaceIndex + 1).trim()];
}
