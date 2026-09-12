/**
 * Data classes from [07 §3.2]. Every route declares one; `@cuc/http` uses it to
 * enforce hard rule H1 and services use it to decide what to audit.
 */
export const DATA_CLASSES = ['config', 'private', 'usage', 'secret'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

/**
 * A permission from the catalog in [07 §3.3], e.g. `cdr.read`.
 *
 * It stays a plain string here: the catalog and the `allowed()` evaluation land
 * with `@cuc/authz` in S1, and `@cuc/http` must not become the place where the
 * catalog is defined.
 */
export type Permission = string;

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

export function isDataClass(value: unknown): value is DataClass {
  return typeof value === 'string' && (DATA_CLASSES as readonly string[]).includes(value);
}
