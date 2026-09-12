/**
 * The tenancy facts a data access call needs.
 *
 * It is deliberately a subset of `@cuc/http`'s `RequestContext`, so a route
 * handler passes `request.context` straight through, and a background job
 * constructs one explicitly.
 */
export interface DbContext {
  /** Required by `scoped`. Absent for master and reseller actors. */
  readonly tenantId?: string;
  readonly resellerId?: string;
  readonly orgId?: string;
  readonly orgType?: 'master' | 'reseller' | 'tenant';
  readonly actorId?: string;
  readonly requestId?: string;
}

/** A context that is known to carry a tenant. */
export interface TenantContext extends DbContext {
  readonly tenantId: string;
}

/** Thrown when `scoped` is called without a tenant to scope to. */
export class MissingTenantContextError extends Error {
  override readonly name = 'MissingTenantContextError';

  constructor() {
    super(
      'scoped(ctx) requires ctx.tenantId. A master or reseller actor reading across ' +
        'tenants must use unscoped(ctx, reason), which records why.',
    );
  }
}

/** Narrows a context, throwing rather than silently querying every tenant. */
export function requireTenant(ctx: DbContext): TenantContext {
  if (ctx.tenantId === undefined || ctx.tenantId === '') throw new MissingTenantContextError();
  return ctx as TenantContext;
}
