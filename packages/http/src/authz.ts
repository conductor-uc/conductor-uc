import { h1RouteLevelWall } from '@cuc/authz';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { RouteContract } from './contract.js';
import { ProblemError } from './problem.js';
import type { Server } from './server-type.js';

/**
 * Hard rule H1, the reseller private-data wall (07 §3.1).
 *
 * An actor whose org is a reseller is denied any route whose data class is
 * `private`, whatever roles or grants exist. It is enforced here rather than
 * in each service so that no route can forget it, and it runs before any
 * handler.
 *
 * `h1RouteLevelWall` is the coarse form of the check: at this point there is
 * only the actor's org type and the route's declared data class, not a
 * resource to compare an org against. `@cuc/authz`'s full `allowed()`
 * evaluation — org ancestry, roles, grants, and the resource-aware H1 — is
 * what a service calls once it knows what it is actually serving.
 */
export function registerHardRules(app: Server): void {
  app.addHook('preHandler', (request: FastifyRequest, _reply: FastifyReply, done: () => void) => {
    const contract = (request.routeOptions.config ?? {}) as RouteContract;

    if (
      contract.dataClass !== undefined &&
      request.context.orgType !== undefined &&
      !h1RouteLevelWall(request.context.orgType, contract.dataClass)
    ) {
      request.log.warn(
        { permission: contract.permission, dataClass: contract.dataClass },
        'H1: reseller denied private tenant data',
      );
      throw ProblemError.forbidden('Resellers cannot access private tenant data.', {
        code: 'reseller_private_data_denied',
      });
    }
    done();
  });
}
