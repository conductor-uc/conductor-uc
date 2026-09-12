import type { Kysely } from 'kysely';
import type { Logger } from '@cuc/logger';

import type { DbContext } from './context.js';

/** Thrown when `unscoped` is called without saying why. */
export class MissingUnscopedReasonError extends Error {
  override readonly name = 'MissingUnscopedReasonError';

  constructor() {
    super(
      'unscoped(ctx, reason) requires a non-empty reason. It is recorded on the ' +
        'audit trail, so write what the query is for, not that it is unscoped.',
    );
  }
}

/** One cross-tenant access, as handed to the audit sink. */
export interface UnscopedAccess {
  readonly reason: string;
  readonly actorId?: string;
  readonly orgId?: string;
  readonly orgType?: DbContext['orgType'];
  readonly tenantId?: string;
  readonly requestId?: string;
  readonly at: string;
}

export type UnscopedAccessSink = (access: UnscopedAccess) => void;

/**
 * Escapes tenant scoping for queries that legitimately span tenants: master and
 * reseller dashboards, and background jobs (05 §2.3).
 *
 * The reason is mandatory and is reported to the audit sink. Until `@cuc/audit`
 * lands, the default sink logs at `warn` — which is the point: a cross-tenant
 * read should be visible in a log search, not indistinguishable from any other
 * query.
 */
export function unscopedFor<DB>(
  db: Kysely<DB>,
  ctx: DbContext,
  reason: string,
  sink: UnscopedAccessSink,
): Kysely<DB> {
  if (reason.trim() === '') throw new MissingUnscopedReasonError();

  sink({
    reason,
    at: new Date().toISOString(),
    ...pick(ctx, ['actorId', 'orgId', 'orgType', 'tenantId', 'requestId']),
  });

  return db;
}

/** The default sink: a `warn` line carrying the reason and the actor. */
export function loggingUnscopedSink(logger: Logger): UnscopedAccessSink {
  return (access) => {
    logger.warn({ unscopedAccess: access }, 'cross-tenant query');
  };
}

function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Partial<T> {
  const out: Partial<T> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}
