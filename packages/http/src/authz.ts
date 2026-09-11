import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Server } from './server-type.js';

import type { RouteContract } from './contract.js';
import { ProblemError } from './problem.js';

/**
 * Hard rule H1, the reseller private-data wall (07 §3.1).
 *
 * An actor whose org is a reseller is denied any route whose data class is
 * `private`, whatever roles or grants exist. It is enforced here rather than in
 * each service so that no route can forget it, and it runs before any handler.
 *
 * The full `allowed()` evaluation — org ancestry, roles, grants — belongs to
 * `@cuc/authz` in S1. This hook only applies the part that no grant may
 * override.
 */
export function registerHardRules(app: Server): void {
  app.addHook('preHandler', (request: FastifyRequest, _reply: FastifyReply, done: () => void) => {
    const contract = (request.routeOptions.config ?? {}) as RouteContract;

    if (contract.dataClass === 'private' && request.context.orgType === 'reseller') {
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
