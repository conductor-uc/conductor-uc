import { ProblemError, Type, type Server } from '@cuc/http';
import type { DbContext } from '@cuc/db';

import { normalize{{Entity}}Name, Invalid{{Entity}}NameError } from '../domain/{{kebabEntity}}.js';
import type { {{Entity}}Repo } from '../repo/{{kebabEntity}}.repo.js';

const {{Entity}}Schema = Type.Object({
  id: Type.String(),
  name: Type.String(),
});

const TenantParamsSchema = Type.Object({ tenantId: Type.String() });
const CreateBodySchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 128 }),
});

/**
 * Builds the tenant context for one request.
 *
 * The tenant comes from the URL, per the `/v1/tenants/{tenantId}/…` convention
 * (09 §2) — `request.context` alone is not enough here, because it only carries
 * a tenant when this service trusts the `x-internal-*` headers, which is true
 * only behind api-gateway (see `TRUST_INTERNAL_HEADERS` in config.ts).
 *
 * Once identity-service and the authz grant model land (S1), this is also
 * where a request whose trusted context disagrees with its URL gets rejected —
 * a tenant actor must not be able to name a *different* tenant in the path.
 * That check does not exist yet, so this is a real gap the template leaves
 * for the reader rather than papering over.
 */
function ctxFor(request: {
  readonly context: DbContext;
  readonly params: { readonly tenantId: string };
}): DbContext {
  return { ...request.context, tenantId: request.params.tenantId };
}

/**
 * Registers the {{entity}} routes.
 *
 * Every route declares `permission` and `dataClass` — @cuc/http refuses to
 * register a route that does not (CLAUDE.md rule 3).
 */
export function register{{Entity}}Routes(app: Server, repo: {{Entity}}Repo): void {
  app.get(
    '/v1/tenants/:tenantId/{{table}}',
    {
      config: { permission: '{{entity}}.manage', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array({{Entity}}Schema) }) },
      },
    },
    async (request) => ({ rows: await repo.list(ctxFor(request)) }),
  );

  app.get(
    '/v1/tenants/:tenantId/{{table}}/:id',
    {
      config: { permission: '{{entity}}.manage', dataClass: 'config' },
      schema: {
        params: Type.Object({ tenantId: Type.String(), id: Type.String() }),
        response: { 200: {{Entity}}Schema },
      },
    },
    async (request) => {
      const found = await repo.findById(ctxFor(request), request.params.id);
      if (found === undefined) throw ProblemError.notFound(`No {{entity}} with that id.`);
      return found;
    },
  );

  app.post(
    '/v1/tenants/:tenantId/{{table}}',
    {
      config: { permission: '{{entity}}.manage', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        body: CreateBodySchema,
        response: { 201: {{Entity}}Schema },
      },
    },
    async (request, reply) => {
      let name: string;
      try {
        name = normalize{{Entity}}Name(request.body.name);
      } catch (error) {
        if (error instanceof Invalid{{Entity}}NameError) {
          throw ProblemError.badRequest(error.message);
        }
        throw error;
      }

      const created = await repo.create(ctxFor(request), name);
      return reply.status(201).send(created);
    },
  );
}
