import { isKnownPermission, SCOPE_TYPES } from '@cuc/authz';
import { ProblemError, Type, type Server } from '@cuc/http';

import type { ActorContext, OrgAccess } from '../authz/org-access.js';
import type { PermissionLookup } from '../authz/permission-lookup.js';
import { GrantNotFoundError, type GrantRepo } from '../repo/grant.repo.js';

const OrgParamsSchema = Type.Object({ orgId: Type.String({ minLength: 1 }) });
const GrantParamsSchema = Type.Object({
  orgId: Type.String({ minLength: 1 }),
  grantId: Type.String({ minLength: 1 }),
});

const ScopeTypeSchema = Type.Union(SCOPE_TYPES.map((type) => Type.Literal(type)));

const CreateGrantBodySchema = Type.Object({
  principalType: Type.Union([Type.Literal('user'), Type.Literal('role')]),
  principalId: Type.String({ minLength: 1 }),
  permission: Type.String({ minLength: 1 }),
  scope: Type.Object({ type: ScopeTypeSchema, id: Type.String({ minLength: 1 }) }),
});

const GrantSchema = Type.Object({
  id: Type.String(),
  principalType: Type.Union([Type.Literal('user'), Type.Literal('role')]),
  principalId: Type.String(),
  permission: Type.String(),
  scope: Type.Object({ type: Type.String(), id: Type.String() }),
});

const MONITOR_ACTIONS: ReadonlySet<string> = new Set([
  'monitor.listen',
  'monitor.whisper',
  'monitor.barge',
]);

/**
 * G-121 (7), the owner's decision: a tenant's own administrator may give a person monitoring of
 * one extension or one queue (a queue lead) without holding monitoring themselves, which by
 * design they do not (07 §3.3). Only `monitor.listen`/`whisper`/`barge`; only scoped to an
 * extension or a queue, never the whole org; only to a user, never a role (a role could reach the
 * granter); and only inside the granter's own tenant. It is less than the `tenant_supervisor` role
 * the administrator can already assign, and the granter still cannot grant it to themselves.
 */
function monitoringOnOneTarget(
  body: { principalType: string; permission: string; scope: { type: string } },
  actorOrgType: string | undefined,
  actorOrgId: string,
  orgId: string,
): boolean {
  return (
    MONITOR_ACTIONS.has(body.permission) &&
    (body.scope.type === 'extension' || body.scope.type === 'queue') &&
    body.principalType === 'user' &&
    actorOrgType === 'tenant' &&
    actorOrgId === orgId
  );
}

/**
 * `/v1/orgs/{orgId}/grants` (06). A grant is a permission on a specific scope
 * for one principal (07 §3.1) — narrower than a role, and the mechanism for
 * "own extension, voicemail, and recordings where granted" (07 §3.3).
 */
export function registerGrantRoutes(
  app: Server,
  grants: GrantRepo,
  access: OrgAccess,
  lookup: PermissionLookup,
): void {
  /** The org the request names, once the actor is known to be allowed to manage it. */
  async function managedOrg(request: {
    context: ActorContext;
    params: { orgId: string };
  }): Promise<string> {
    return (await access.resolve(request.context, request.params.orgId)).orgId;
  }

  app.get(
    '/v1/orgs/:orgId/grants',
    {
      config: { permission: 'grant.read', dataClass: 'config' },
      schema: {
        params: OrgParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(GrantSchema) }) },
      },
    },
    async (request) => ({ rows: await grants.listForOrg(await managedOrg(request)) }),
  );

  app.post(
    '/v1/orgs/:orgId/grants',
    {
      config: { permission: 'grant.manage', dataClass: 'config' },
      schema: {
        params: OrgParamsSchema,
        body: CreateGrantBodySchema,
        response: { 201: GrantSchema },
      },
    },
    async (request, reply) => {
      const orgId = await managedOrg(request);
      const { actorId, orgId: actorOrgId } = request.context;
      if (actorId === undefined || actorOrgId === undefined) {
        throw ProblemError.unauthorized('Sign in to manage grants.');
      }
      // A grant is a way to give someone access: never to yourself, and never
      // something you do not hold (the master holds every permission).
      if (request.body.principalType === 'user' && request.body.principalId === actorId) {
        throw ProblemError.forbidden('You cannot grant yourself access.', {
          code: 'cannot_grant_self',
        });
      }
      if (!isKnownPermission(request.body.permission)) {
        throw ProblemError.badRequest(`'${request.body.permission}' is not a permission.`, {
          code: 'unknown_permission',
        });
      }
      if (
        !monitoringOnOneTarget(request.body, request.context.orgType, actorOrgId, orgId) &&
        !(await lookup.ofUser(actorId, actorOrgId)).has(request.body.permission)
      ) {
        throw ProblemError.forbidden('You cannot grant a permission you do not hold.', {
          code: 'permission_escalation',
        });
      }
      const created = await grants.create(
        orgId,
        request.body.principalType,
        request.body.principalId,
        request.body.permission,
        request.body.scope,
      );
      return reply.status(201).send(created);
    },
  );

  app.delete(
    '/v1/orgs/:orgId/grants/:grantId',
    {
      config: { permission: 'grant.manage', dataClass: 'config' },
      schema: { params: GrantParamsSchema },
    },
    async (request, reply) => {
      try {
        await grants.revoke(await managedOrg(request), request.params.grantId);
      } catch (error) {
        if (error instanceof GrantNotFoundError) {
          throw ProblemError.notFound(error.message);
        }
        throw error;
      }
      return reply.status(204).send();
    },
  );
}
