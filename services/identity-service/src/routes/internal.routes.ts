import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server } from '@cuc/http';

import { EmailTakenError, type UserRepo } from '../repo/user.repo.js';

const AdminUserBodySchema = Type.Object({
  orgType: Type.Union([Type.Literal('master'), Type.Literal('reseller'), Type.Literal('tenant')]),
  resellerId: Type.Optional(Type.String({ minLength: 1 })),
  email: Type.String({ minLength: 1 }),
  displayName: Type.String({ minLength: 1 }),
  password: Type.String({ minLength: 12 }),
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

      try {
        const user = await users.create(request.context, {
          orgId: request.params.orgId,
          orgType: request.body.orgType,
          resellerId: request.body.resellerId ?? null,
          email: request.body.email,
          displayName: request.body.displayName,
          password: request.body.password,
        });
        return reply.status(201).send({
          id: user.id,
          orgId: user.orgId,
          email: user.email,
          displayName: user.displayName,
        });
      } catch (error) {
        if (error instanceof EmailTakenError) {
          throw ProblemError.conflict(error.message, { code: 'email_taken' });
        }
        throw error;
      }
    },
  );
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token !== undefined && token !== '' ? token : undefined;
}
