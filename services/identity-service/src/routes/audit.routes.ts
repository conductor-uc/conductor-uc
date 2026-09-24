import { ProblemError, Type, type Server } from '@cuc/http';

import type { OrgAccess } from '../authz/org-access.js';
import type { AuditRepo } from '../repo/audit.repo.js';

const OrgParamsSchema = Type.Object({ orgId: Type.String({ minLength: 1 }) });
// A querystring value is always a string — @cuc/http's Ajv instance has
// coerceTypes: false (deliberately, per its server.ts), so `Type.Integer()`
// here would reject every request that actually sets `limit`. Validate the
// digit shape as a string, then parse it in the handler.
const QuerySchema = Type.Object({
  limit: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$' })),
});

const AuditEventSchema = Type.Object({
  id: Type.String(),
  at: Type.String(),
  actorType: Type.String(),
  actorId: Type.String(),
  actorOrgId: Type.String(),
  targetOrgId: Type.Union([Type.String(), Type.Null()]),
  action: Type.String(),
  resource: Type.String(),
  dataClass: Type.String(),
  reason: Type.Union([Type.String(), Type.Null()]),
  ip: Type.Union([Type.String(), Type.Null()]),
  requestId: Type.Union([Type.String(), Type.Null()]),
});

/**
 * `GET /v1/orgs/:orgId/audit-events` (06). Declares `dataClass: 'config'`
 * rather than the catalog's mixed `config/private` for `audit.read` (07
 * §3.3) — see G-13 in `docs/decisions.md`: a route can only declare one
 * class, and declaring `private` would have H1's coarse, route-level wall
 * block `reseller_admin`/`reseller_support` outright, even though they hold
 * `audit.read` and are entitled to their own org's trail. The real
 * visibility rule is enforced in the query (`AuditRepo.listForOrg`), not by
 * this declaration.
 *
 * Which org's trail may be read is checked with [OrgAccess] (S3-05): the
 * actor's own, or one beneath them.
 */
export function registerAuditRoutes(app: Server, repo: AuditRepo, access: OrgAccess): void {
  app.get(
    '/v1/orgs/:orgId/audit-events',
    {
      config: { permission: 'audit.read', dataClass: 'config' },
      schema: {
        params: OrgParamsSchema,
        querystring: QuerySchema,
        response: { 200: Type.Object({ rows: Type.Array(AuditEventSchema) }) },
      },
    },
    async (request) => {
      const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
      if (limit !== undefined && limit > 500) {
        throw ProblemError.badRequest('limit must be at most 500.');
      }
      // Own org, or (master, reseller) one beneath the actor: never anyone else's.
      const org = await access.resolve(request.context, request.params.orgId);
      const events = await repo.listForOrg(org.orgId, limit);
      return {
        rows: events.map((event) => ({ ...event, at: event.at.toISOString() })),
      };
    },
  );
}
