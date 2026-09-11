import type { RouteOptions } from 'fastify';

import type { Server } from './server-type.js';

import { DATA_CLASSES, isDataClass, type RegisteredRoute, type RouteContract } from './contract.js';

/**
 * Thrown during route registration when a route does not declare its contract.
 *
 * Registration-time rather than request-time on purpose: a route that forgets
 * its `dataClass` must not be reachable at all, and the service should fail to
 * boot rather than serve it (CLAUDE.md rule 3).
 */
export class RouteContractError extends Error {
  override readonly name = 'RouteContractError';

  constructor(method: string, url: string, problem: string) {
    super(
      `Route ${method} ${url} ${problem}. ` +
        `Declare it as config: { permission: 'extension.manage', dataClass: 'config' }, ` +
        `or config: { public: true } for health and OpenAPI routes only.`,
    );
  }
}

function methodsOf(route: RouteOptions): string[] {
  return Array.isArray(route.method) ? route.method : [route.method];
}

/**
 * Registers the `onRoute` guard and the route registry.
 *
 * The registry is exposed as `app.registeredRoutes` so a CI test can assert
 * over the whole surface of a service (07 §3.2).
 */
export function registerRouteContractGuard(app: Server): void {
  const registry: RegisteredRoute[] = [];
  app.decorate('registeredRoutes', registry);

  app.addHook('onRoute', (route: RouteOptions) => {
    const contract = (route.config ?? {}) as RouteContract;
    const method = methodsOf(route).join(',');

    if (contract.public === true) {
      if (contract.permission !== undefined || contract.dataClass !== undefined) {
        throw new RouteContractError(
          method,
          route.url,
          'is marked public but also declares a permission or data class',
        );
      }
      for (const single of methodsOf(route)) {
        registry.push({
          method: single,
          url: route.url,
          permission: null,
          dataClass: null,
          public: true,
        });
      }
      return;
    }

    if (contract.permission === undefined || contract.permission === '') {
      throw new RouteContractError(method, route.url, 'does not declare a permission');
    }
    if (contract.dataClass === undefined) {
      throw new RouteContractError(method, route.url, 'does not declare a dataClass');
    }
    if (!isDataClass(contract.dataClass)) {
      throw new RouteContractError(
        method,
        route.url,
        `declares an unknown dataClass '${String(contract.dataClass)}'; expected one of ${DATA_CLASSES.join(', ')}`,
      );
    }

    for (const single of methodsOf(route)) {
      registry.push({
        method: single,
        url: route.url,
        permission: contract.permission,
        dataClass: contract.dataClass,
        public: false,
      });
    }
  });
}
