import { h1RouteLevelWall, h3RouteLevelLifecycle } from '@cuc/authz';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { RouteContract } from './contract.js';
import { ProblemError } from './problem.js';
import type { Server } from './server-type.js';

/**
 * Hard rules H1 and H3 (07 §3.1), enforced here rather than in each service
 * so that no route can forget them, and before any handler runs.
 *
 * `h1RouteLevelWall` is the coarse form of H1: at this point there is only
 * the actor's org type and the route's declared data class, not a resource to
 * compare an org against. `@cuc/authz`'s full `allowed()` evaluation — org
 * ancestry, roles, grants, and the resource-aware H1 — is what a service
 * calls once it knows what it is actually serving.
 *
 * H3 needs no resource-aware counterpart — `h3RouteLevelLifecycle` is the
 * full rule, not an approximation of one, because 07 §3.1 reserves
 * `reseller.create`/`reseller.manage` to the master unconditionally,
 * regardless of what the route happens to be serving.
 */
export function registerHardRules(app: Server): void {
  app.addHook('preHandler', (request: FastifyRequest, _reply: FastifyReply, done: () => void) => {
    const contract = (request.routeOptions.config ?? {}) as RouteContract;
    if (request.context.orgType === undefined) {
      done();
      return;
    }

    if (
      contract.dataClass !== undefined &&
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

    if (
      contract.permission !== undefined &&
      !h3RouteLevelLifecycle(request.context.orgType, contract.permission)
    ) {
      request.log.warn(
        { permission: contract.permission },
        'H3: only the master may create or manage resellers',
      );
      throw ProblemError.forbidden('Only the master may create or manage resellers.', {
        code: 'reseller_lifecycle_denied',
      });
    }
    done();
  });
}
