import type { DbContext } from '@cuc/db';
import { Type, type Server } from '@cuc/http';

import { CDR_DIRECTIONS } from '../domain/cdr.js';
import type { CdrRepo } from '../repo/cdr.repo.js';

const BillingParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });
const BillingListQuerySchema = Type.Object({
  from: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
  direction: Type.Optional(Type.Union(CDR_DIRECTIONS.map((value) => Type.Literal(value)))),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
});

/**
 * A billing record (C-1/D-013, issue #95) — the `usage`-class view built
 * from the same underlying `cdrs` row as `cdr.routes.ts`'s own `CdrSchema`,
 * but only the columns C-1's resolution lists as safe for a reseller: no
 * recordings, no per-leg detail, no SIP metadata, no caller name, no
 * internal extension id. `toNumber` is the full destination number, not a
 * truncated prefix (issue #95's own answer to "does rating need the full
 * number").
 */
const BillingRecordSchema = Type.Object({
  id: Type.String(),
  callId: Type.String(),
  direction: Type.String(),
  startAt: Type.String(),
  billableSec: Type.Number(),
  toNumber: Type.String(),
  trunkId: Type.Union([Type.String(), Type.Null()]),
});

function ctxFor(request: {
  readonly context: DbContext;
  readonly params: { readonly tenantId: string };
}): DbContext {
  return { ...request.context, tenantId: request.params.tenantId };
}

/**
 * Registers `/v1/tenants/{tenantId}/billing-records` (S2-18; C-1/D-013).
 * `billing.read` is a new permission (`packages/authz`'s own doc comment on
 * why) with `usage` dataClass — unlike `cdr.routes.ts`'s `private`-class
 * surface, H1 does not block a reseller here, and ordinary org-ancestry
 * (07 §3.1) already lets a reseller reach this for any of its own tenants,
 * so there is no separate cross-tenant "all my tenants" endpoint: the same
 * per-tenant URL shape `cdr.routes.ts` uses is enough.
 *
 * The master-level rollup C-1's own answer #3 describes ("all CDRs for all
 * call types and number of extensions, broken down per type, for each
 * tenant") is not built here — no concrete API shape for it is specified
 * anywhere this task can build against with confidence, so it is left as a
 * gap rather than guessed at (docs/decisions.md G-53).
 */
export function registerBillingRoutes(app: Server, cdrs: CdrRepo): void {
  app.get(
    '/v1/tenants/:tenantId/billing-records',
    {
      config: { permission: 'billing.read', dataClass: 'usage' },
      schema: {
        params: BillingParamsSchema,
        querystring: BillingListQuerySchema,
        response: {
          200: Type.Object({
            rows: Type.Array(BillingRecordSchema),
            nextCursor: Type.Union([Type.String(), Type.Null()]),
          }),
        },
      },
    },
    async (request) => {
      const query = request.query;
      const page = await cdrs.list(ctxFor(request), {
        ...(query.from === undefined ? {} : { from: new Date(query.from) }),
        ...(query.to === undefined ? {} : { to: new Date(query.to) }),
        ...(query.direction === undefined ? {} : { direction: query.direction }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
      return {
        rows: page.rows.map((cdr) => ({
          id: cdr.id,
          callId: cdr.callUuid,
          direction: cdr.direction,
          startAt: cdr.startAt.toISOString(),
          billableSec: cdr.billableSec,
          toNumber: cdr.toNumber,
          trunkId: cdr.trunkId,
        })),
        nextCursor: page.nextCursor,
      };
    },
  );
}
