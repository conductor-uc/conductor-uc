import type { FastifyReply, FastifyRequest } from 'fastify';

import type { RouteContract } from './contract.js';
import type { RequestContext } from './context.js';
import { ProblemError } from './problem.js';
import type { Server } from './server-type.js';

/**
 * Whether the context names a caller: a person or key the gateway signed for,
 * or another service that presented the internal service token.
 */
function isAuthenticated(context: RequestContext): boolean {
  if (context.actorType === 'service') return true;
  return context.actorType !== undefined && context.actorId !== undefined;
}

/**
 * Refuses an unauthenticated request on every route that declares a
 * permission (G-112). Registered by {@link createServer} for every service that
 * trusts `x-internal-*` headers, whether or not it also passes a permission
 * resolver.
 *
 * Without it, a request that reached a service directly with no headers at
 * all got an anonymous context, which the permission guard and the H1/H3
 * hooks all let through (they judge a caller, and there was none), so the
 * handler served whatever tenant the URL named. Now such a request needs
 * either a valid signed context from api-gateway or the shared internal
 * service token; forged headers were already refused while the context was
 * built. Public routes (`public: true`: sign-in, health, the OpenAPI document,
 * internal routes that check the token themselves) are unaffected.
 *
 * Runs `onRequest`, before the body is parsed or validated, so an
 * unauthenticated caller learns nothing about what a route expects.
 */
export function registerAuthenticationRequirement(app: Server): void {
  app.addHook('onRequest', (request: FastifyRequest, _reply: FastifyReply, done: () => void) => {
    const contract = (request.routeOptions.config ?? {}) as RouteContract;
    if (contract.public === true || contract.permission === undefined) {
      done();
      return;
    }
    if (!isAuthenticated(request.context)) {
      throw ProblemError.unauthorized('Authentication required.', {
        code: 'authentication_required',
      });
    }
    done();
  });
}
