import type { RegisteredRoute, RouteContract } from './contract.js';
import type { RequestContext } from './context.js';
import type { ReadinessCheck, StatusSection } from './health.js';
import type { GaugeOptions, GaugeRead } from './metrics.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Identity and correlation for this request. Always set. */
    context: RequestContext;
  }

  interface FastifyInstance {
    /** Every route registered on this instance, with its declared contract. */
    registeredRoutes: RegisteredRoute[];
    /** Adds a dependency check to `GET /readyz`. */
    addReadinessCheck: (name: string, check: ReadinessCheck) => void;
    /** S4-12: adds a named section to `GET /statusz` (e.g. `outbox`). */
    addStatusSection: (name: string, section: StatusSection) => void;
    /** S4-13: adds a gauge to `GET /metrics`, read at each scrape. */
    addGauge: (name: string, options: GaugeOptions, read: GaugeRead) => void;
  }

  /**
   * Makes `permission` and `dataClass` the shape of `config` on every route, so
   * a route that omits them is a type error as well as a registration failure.
   *
   * The empty body is the whole point: this only widens Fastify's own
   * `FastifyContextConfig` with the contract's members.
   */
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface FastifyContextConfig extends RouteContract {}
}

export {};
