import { h1RouteLevelWall } from '@cuc/authz';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { RouteContract } from './contract.js';
import type { OrgType, RequestContext } from './context.js';
import { ProblemError } from './problem.js';
import type { Server } from './server-type.js';

/** Who is asking, as far as a permission lookup needs to know. */
export interface PermissionActor {
  readonly id: string;
  readonly orgId: string;
  readonly orgType: OrgType;
}

/**
 * Says whether `actor` holds `permission`. It is asked once per request for a
 * person (`actorType: 'user'`), never for a service, node or API key, and it
 * must fail closed: throw (a 503 for the caller) rather than answer `true`
 * when it cannot tell.
 */
export type PermissionResolver = (actor: PermissionActor, permission: string) => Promise<boolean>;

/**
 * `org.view` is what every signed-in person needs to be shown their own
 * organization's brand and what they may do (`@cuc/authz` gives it to every
 * built-in role, and the sign-in flow asks for it before anything else). It
 * reads no tenant records, so it is never checked here: a person with no role
 * yet (a fresh invitee) can still ask what they can do.
 */
const ALWAYS_ALLOWED: ReadonlySet<string> = new Set(['org.view']);

/**
 * Per-request authorization for signed-in people (07 §3.1). Registered by
 * {@link createServer} when a service passes `permissions`.
 *
 * Checks, run before validation so an unauthorized caller learns nothing from
 * a schema error, and before any handler:
 *
 * 0. **H1** (the same rule `registerHardRules` enforces, repeated here only so
 *    it keeps its own clear answer for a reseller instead of a bare
 *    permission error).
 *
 * 1. **H2, tenant boundary.** A person whose org is a tenant may only name
 *    their own tenant in a `/v1/tenants/{tenantId}/…` path.
 * 2. **The route's declared `permission`.** The resolver must say the person
 *    holds it (through a role, or an org-wide grant).
 *
 * Until this existed the route contract's `permission` was documented but not
 * evaluated by any service (only H1 and H3 were), so any signed-in person
 * could call any route. Self-service gives ordinary people a login, so it
 * cannot ship without it. A reseller or master reaching a tenant is ancestry,
 * which needs an org lookup this guard does not have; it is left to the
 * route's own checks, as before.
 */
export function registerPermissionGuard(app: Server, resolve: PermissionResolver): void {
  app.addHook(
    'preValidation',
    async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      const contract = (request.routeOptions.config ?? {}) as RouteContract;
      const { actorId, actorType, orgId, orgType } = request.context;
      if (contract.public === true || contract.permission === undefined) return;
      if (actorType !== 'user' || actorId === undefined) return;
      if (orgId === undefined || orgType === undefined) return;

      // H1 first, with its own answer (the hard-rules hook runs later, after
      // validation, and would otherwise be pre-empted by this guard's 403).
      if (contract.dataClass !== undefined && !h1RouteLevelWall(orgType, contract.dataClass)) {
        throw ProblemError.forbidden('Resellers cannot access private tenant data.', {
          code: 'reseller_private_data_denied',
        });
      }

      const tenantId = (request.params as { tenantId?: unknown } | undefined)?.tenantId;
      if (orgType === 'tenant' && typeof tenantId === 'string' && tenantId !== orgId) {
        request.log.warn({ permission: contract.permission }, 'H2: tenant boundary');
        throw ProblemError.forbidden('You can only reach your own organization.', {
          code: 'tenant_boundary',
        });
      }

      if (ALWAYS_ALLOWED.has(contract.permission)) return;
      if (!(await resolve({ id: actorId, orgId, orgType }, contract.permission))) {
        request.log.warn({ permission: contract.permission }, 'permission denied');
        throw ProblemError.forbidden('You do not have permission to do that.', {
          code: 'permission_denied',
        });
      }
    },
  );
}

/** The person a self-service (`/me`) request is about, taken only from the signed context. */
export interface SelfActor {
  readonly userId: string;
  readonly tenantId: string;
}

/**
 * Resolves "me" for a self-service route from the signed request context, and
 * from nothing the client supplied: a person (not a key or a service) whose
 * org is the tenant named in the path. Anyone else, a reseller or master
 * included, gets a 403, so a self-service route never has a way to be pointed
 * at another person. The route then looks the person's own records up by the
 * returned `userId`; it must not accept a user, extension or mailbox id from
 * the client to do it.
 */
export function selfActor(request: {
  readonly context: RequestContext;
  readonly params: { readonly tenantId: string };
}): SelfActor {
  const { actorId, actorType, orgId, orgType } = request.context;
  if (actorId === undefined || actorType === undefined || orgId === undefined) {
    throw ProblemError.unauthorized('Sign in to continue.');
  }
  if (actorType !== 'user' || orgType !== 'tenant' || orgId !== request.params.tenantId) {
    throw ProblemError.forbidden('This is only available to a person in their own organization.', {
      code: 'self_service_only',
    });
  }
  return { userId: actorId, tenantId: orgId };
}

export interface RemotePermissionResolverOptions {
  /** identity-service, e.g. `http://identity-service:8080`. */
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  /** How long what a person holds is reused. Short: taking a role away takes at most this long to bite. */
  readonly ttlMs?: number;
  /** Injected in tests. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

/**
 * Asks identity-service (`GET /internal/v1/orgs/:orgId/users/:userId/permissions`,
 * shared service token) what a person may do, and caches the answer briefly.
 * An unknown or disabled person holds nothing. If identity-service cannot be
 * reached the request fails (503) rather than being let through.
 */
export function createRemotePermissionResolver(
  options: RemotePermissionResolverOptions,
): PermissionResolver {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 5_000;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const cache = new Map<string, { expires: number; permissions: ReadonlySet<string> }>();

  async function permissionsOf(actor: PermissionActor): Promise<ReadonlySet<string>> {
    const key = `${actor.orgId}:${actor.id}`;
    const hit = cache.get(key);
    if (hit !== undefined && hit.expires > now()) return hit.permissions;

    let response: Response;
    try {
      response = await fetchImpl(
        `${baseUrl}/internal/v1/orgs/${encodeURIComponent(actor.orgId)}/users/${encodeURIComponent(actor.id)}/permissions`,
        { headers: { authorization: `Bearer ${options.internalServiceToken}` } },
      );
    } catch {
      throw ProblemError.unavailable('Could not check your permissions. Try again shortly.');
    }
    let permissions: ReadonlySet<string>;
    if (response.status === 404) {
      permissions = new Set();
    } else if (response.ok) {
      const body = (await response.json()) as { permissions: string[] };
      permissions = new Set(body.permissions);
    } else {
      throw ProblemError.unavailable('Could not check your permissions. Try again shortly.');
    }
    // Only what a person holds is remembered. "Holds nothing" is asked again
    // every time, so a role given a moment ago works at once; taking a role
    // away takes at most `ttlMs` to bite.
    if (permissions.size > 0) {
      cache.set(key, { expires: now() + ttlMs, permissions });
      if (cache.size > 10_000) cache.clear();
    }
    return permissions;
  }

  return async (actor, permission) => (await permissionsOf(actor)).has(permission);
}
