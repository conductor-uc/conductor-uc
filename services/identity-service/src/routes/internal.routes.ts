import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server } from '@cuc/http';

import { assertPasswordDistinct, PasswordInUseError } from '../auth/ambiguity.js';
import type { RoleRepo } from '../repo/role.repo.js';
import { EmailTakenError, type UserRepo } from '../repo/user.repo.js';

const AdminUserBodySchema = Type.Object({
  orgType: Type.Union([Type.Literal('master'), Type.Literal('reseller'), Type.Literal('tenant')]),
  resellerId: Type.Optional(Type.String({ minLength: 1 })),
  email: Type.String({ minLength: 1 }),
  displayName: Type.String({ minLength: 1 }),
  password: Type.String({ minLength: 12 }),
  /**
   * Create the user only while the org has nobody yet; otherwise 409
   * `org_has_users` and nothing changes. The master bootstrap sets it so that
   * re-running it is a no-op (G-115).
   */
  firstUserOnly: Type.Optional(Type.Boolean()),
});

const AdminUserParamsSchema = Type.Object({ orgId: Type.String({ minLength: 1 }) });

/**
 * `POST /internal/v1/orgs/:orgId/admin-user` (06). What org-service's
 * bootstrap CLI calls to create the master's first admin — S1-05's stated
 * scope is exactly this endpoint, not the general user CRUD API.
 *
 * Gated by a shared bearer token, matching the precedent 07 §1 sets for FS
 * nodes and OpenSIPs, because real service-to-service auth (mTLS or a service
 * JWT) does not exist yet. `config: { public: true }` at the @cuc/http level
 * because there is no org-scoped permission model for a service caller either
 * — the token check below is the actual gate, done inside the handler rather
 * than left to a permission this route cannot honestly claim to have.
 */
export function registerInternalRoutes(
  app: Server,
  users: UserRepo,
  roles: RoleRepo,
  internalServiceToken: string,
): void {
  app.post(
    '/internal/v1/orgs/:orgId/admin-user',
    {
      config: { public: true },
      schema: { params: AdminUserParamsSchema, body: AdminUserBodySchema },
    },
    async (request, reply) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }

      // Not atomic with the insert below: it guards against re-running a
      // bootstrap, not against two bootstraps racing each other.
      if (request.body.firstUserOnly === true && (await users.hasAnyInOrg(request.params.orgId))) {
        throw ProblemError.conflict('This org already has users; no user was created.', {
          code: 'org_has_users',
        });
      }

      try {
        await assertPasswordDistinct(
          users,
          {
            orgId: request.params.orgId,
            orgType: request.body.orgType,
            resellerId: request.body.resellerId ?? null,
          },
          request.body.email,
          request.body.password,
        );
        const user = await users.create(request.context, {
          orgId: request.params.orgId,
          orgType: request.body.orgType,
          resellerId: request.body.resellerId ?? null,
          email: request.body.email,
          displayName: request.body.displayName,
          password: request.body.password,
        });
        // The first person of an org has to be able to do something: give them
        // the org's built-in admin role. Without it `/me` lists no permissions
        // and the console shows nothing. Assigning is idempotent.
        await roles.assignRole(user.id, `${request.body.orgType}_admin`, request.params.orgId);
        return reply.status(201).send({
          id: user.id,
          orgId: user.orgId,
          email: user.email,
          displayName: user.displayName,
        });
      } catch (error) {
        if (error instanceof PasswordInUseError) {
          throw ProblemError.conflict(error.message, { code: 'password_in_use' });
        }
        if (error instanceof EmailTakenError) {
          throw ProblemError.conflict(error.message, { code: 'email_taken' });
        }
        throw error;
      }
    },
  );

  registerInternalAdminsRoute(app, users, internalServiceToken);
}

/**
 * `GET /internal/v1/orgs/:orgId/admins` (G-100): the org's active
 * administrators, with the address to write to. notification-service asks
 * when it tells an org's other admins that someone's two-step verification
 * was reset, so the event itself stays thin. The caller leaves out whoever it
 * should not write to (the acting admin, the affected person).
 *
 * Gated by the same internal service token as the admin-user route; nothing
 * here is reachable through api-gateway.
 */
function registerInternalAdminsRoute(
  app: Server,
  users: UserRepo,
  internalServiceToken: string,
): void {
  app.get(
    '/internal/v1/orgs/:orgId/admins',
    {
      config: { public: true },
      schema: {
        params: AdminUserParamsSchema,
        response: {
          200: Type.Object({
            rows: Type.Array(
              Type.Object({
                userId: Type.String(),
                email: Type.String(),
                displayName: Type.String(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }
      const admins = await users.listActiveAdmins(request.params.orgId);
      return {
        rows: admins.map((u) => ({ userId: u.id, email: u.email, displayName: u.displayName })),
      };
    },
  );
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token !== undefined && token !== '' ? token : undefined;
}
