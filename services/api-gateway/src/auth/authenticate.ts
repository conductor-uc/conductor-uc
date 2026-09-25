import { ProblemError } from '@cuc/http';
import type { Server } from '@cuc/http';

import type { AccessTokenVerifier } from './access-token-verifier.js';
import { InvalidAccessTokenError } from './access-token-verifier.js';
import { isPublicPath } from '../routing/route-table.js';

export interface AuthenticationOptions {
  readonly verifier: AccessTokenVerifier;
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
      throw ProblemError.unauthorized('Authentication required.');
    }

    const [scheme, credential] = splitScheme(header);

    if (scheme === 'bearer' && credential !== undefined) {
      let claims;
      try {
        claims = await options.verifier.verify(credential);
      } catch (error) {
        if (error instanceof InvalidAccessTokenError) {
          throw ProblemError.unauthorized('The access token is invalid or expired.');
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
      // Gap G-14 (docs/decisions.md): identity-service has no api-keys
      // endpoint yet (06 lists it as future scope), so there is nothing here
      // to verify a key against. A distinct 501 rather than a 401 makes that
      // an obviously different failure from "your key is wrong."
      throw new ProblemError(
        501,
        '/problems/not-implemented',
        'Not implemented',
        'api_key_auth_not_implemented',
        { detail: 'API-key authentication is not available yet.' },
      );
    }

    throw ProblemError.unauthorized('Unrecognised authentication scheme.');
  });
}

function splitScheme(header: string): [string, string | undefined] {
  const spaceIndex = header.indexOf(' ');
  if (spaceIndex === -1) return [header.toLowerCase(), undefined];
  return [header.slice(0, spaceIndex).toLowerCase(), header.slice(spaceIndex + 1).trim()];
}
