/**
 * Data classes from [07 §3.2], and permissions from the catalog in [07 §3.3].
 *
 * Both are re-exported from `@cuc/authz` rather than declared here: every
 * route declares a `dataClass`, and `@cuc/authz` is the canonical model of
 * what a data class *means* (H1, auditing) — `@cuc/http` must not become a
 * second place that defines it, or the two can drift.
 */
import { DATA_CLASSES, isDataClass, type DataClass, type Permission } from '@cuc/authz';

export { DATA_CLASSES, isDataClass, type DataClass, type Permission };

/**
 * What a route declares about itself. Fastify carries this on
 * `routeOptions.config`, and {@link routeContractGuard} rejects any route that
 * omits it.
 */
export interface RouteContract {
  /** The permission an actor needs. Required unless `public` is true. */
  readonly permission?: Permission;
  /** The data class this route reads or writes. Required unless `public` is true. */
  readonly dataClass?: DataClass;
  /**
   * Infrastructure routes that carry no tenant data and need no permission:
   * health, readiness, and the OpenAPI document.
   *
   * This is the only way past the contract guard, so it is deliberately
   * awkward: a route that serves tenant data must never set it.
   */
  readonly public?: boolean;
}

/** A route contract after validation, as recorded in the registry. */
export interface RegisteredRoute {
  readonly method: string;
  readonly url: string;
  readonly permission: Permission | null;
  readonly dataClass: DataClass | null;
  readonly public: boolean;
}
