import { apiKeyMayHold, dataClassOf, expandPermissions, isKnownPermission } from '@cuc/authz';
import { secretEquals } from '@cuc/crypto';
import { clientIpOf, ProblemError, Type, type Server } from '@cuc/http';

import type { OrgAccess } from '../authz/org-access.js';
import type { PermissionLookup } from '../authz/permission-lookup.js';
import { isUsable, type ApiKey, type ApiKeyRepo } from '../repo/api-key.repo.js';

const OrgParamsSchema = Type.Object({ orgId: Type.String({ minLength: 1 }) });
const KeyParamsSchema = Type.Object({
  orgId: Type.String({ minLength: 1 }),
  keyId: Type.String({ minLength: 1 }),
});

const ApiKeySchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  /** The key's public id: the key reads `key_<prefix>_…`. */
  prefix: Type.String(),
  permissions: Type.Array(Type.String()),
  createdBy: Type.String(),
  createdAt: Type.String({ format: 'date-time' }),
  expiresAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  lastUsedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  revokedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  /** Neither revoked nor past its end date. */
  active: Type.Boolean(),
});

const CreateBodySchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 128 }),
  permissions: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 200 }),
  /** Optional (G-14): a key with none works until it is revoked. */
  expiresAt: Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()])),
});

function view(key: ApiKey) {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    permissions: [...key.permissions],
    createdBy: key.createdBy,
    createdAt: key.createdAt.toISOString(),
    expiresAt: key.expiresAt?.toISOString() ?? null,
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
    active: isUsable(key),
  };
}

/**
 * `/v1/orgs/{orgId}/api-keys` (S1-08, G-14; 06's identity-service section).
 *
 * - `GET`: the org's keys, never a secret.
 * - `POST` `{name, permissions, expiresAt?}`: a new key. The answer carries the
 *   key itself (`key_<id>_<secret>`) this once; only a hash is kept. The
 *   permissions are refused when one is unknown (`unknown_permission`), is one
 *   H4 keeps from every key (user, role, grant or key management:
 *   `permission_not_for_api_keys`), is one the person creating it does not
 *   hold (`permission_escalation`), or is private data asked for a reseller's
 *   key (`reseller_private_data_denied`, H1). An end date in the past is
 *   `expires_at_in_past`.
 * - `DELETE /{keyId}`: revokes it for good (204); `api_key_not_found`.
 *
 * All `apikey.manage` (class `secret`), for the orgs the person may manage
 * (their own, a reseller's tenants, any for the master), audited as
 * `apikey.created` and `apikey.revoked`. A key cannot reach these routes (H4).
 */
export function registerApiKeyRoutes(
  app: Server,
  keys: ApiKeyRepo,
  access: OrgAccess,
  lookup: PermissionLookup,
): void {
  function actorOf(request: {
    context: { actorId?: string; actorType?: string; orgId?: string; requestId: string };
  }) {
    const { actorId, actorType, orgId, requestId } = request.context;
    if (actorId === undefined || orgId === undefined || actorType !== 'user') {
      throw ProblemError.unauthorized('Sign in to manage API keys.', {
        code: 'sign_in_required',
      });
    }
    return { actorId, orgId, requestId };
  }

  app.get(
    '/v1/orgs/:orgId/api-keys',
    {
      config: { permission: 'apikey.manage', dataClass: 'secret' },
      schema: {
        params: OrgParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(ApiKeySchema) }) },
      },
    },
    async (request) => {
      const org = await access.resolve(request.context, request.params.orgId);
      return { rows: (await keys.list(org.orgId)).map(view) };
    },
  );

  app.post(
    '/v1/orgs/:orgId/api-keys',
    {
      config: { permission: 'apikey.manage', dataClass: 'secret' },
      schema: {
        params: OrgParamsSchema,
        body: CreateBodySchema,
        response: { 201: Type.Object({ apiKey: ApiKeySchema, key: Type.String() }) },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const org = await access.resolve(request.context, request.params.orgId);
      const { name, permissions } = request.body;

      const unknown = permissions.find((p) => !isKnownPermission(p));
      if (unknown !== undefined) {
        throw ProblemError.badRequest(`'${unknown}' is not a permission.`, {
          code: 'unknown_permission',
          params: { permission: unknown },
        });
      }
      const restricted = permissions.find((p) => !apiKeyMayHold(p));
      if (restricted !== undefined) {
        throw ProblemError.badRequest(
          'An API key cannot manage people, roles, grants or other API keys.',
          { code: 'permission_not_for_api_keys', params: { permission: restricted } },
        );
      }
      if (org.type === 'reseller' && permissions.some((p) => dataClassOf(p) === 'private')) {
        throw ProblemError.forbidden('Resellers cannot access private tenant data.', {
          code: 'reseller_private_data_denied',
        });
      }
      const held = await lookup.ofUser(actor.actorId, actor.orgId);
      if (permissions.some((p) => !held.has(p))) {
        throw ProblemError.forbidden('You cannot give a key a permission you do not hold.', {
          code: 'permission_escalation',
        });
      }
      const expiresAt =
        request.body.expiresAt === undefined || request.body.expiresAt === null
          ? null
          : new Date(request.body.expiresAt);
      if (expiresAt !== null && expiresAt.getTime() <= Date.now()) {
        throw ProblemError.badRequest('The end date must be in the future.', {
          code: 'expires_at_in_past',
        });
      }

      const ip = clientIpOf(request);
      const { key, secret } = await keys.create(
        { ...actor, ...(ip === '' ? {} : { ip }) },
        {
          orgId: org.orgId,
          orgType: org.type,
          resellerId: org.resellerId,
          name: name.trim(),
          permissions,
          expiresAt,
        },
      );
      reply.code(201);
      return { apiKey: view(key), key: secret };
    },
  );

  app.delete(
    '/v1/orgs/:orgId/api-keys/:keyId',
    {
      config: { permission: 'apikey.manage', dataClass: 'secret' },
      schema: { params: KeyParamsSchema },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const org = await access.resolve(request.context, request.params.orgId);
      const ip = clientIpOf(request);
      const revoked = await keys.revoke(
        { ...actor, ...(ip === '' ? {} : { ip }) },
        org.orgId,
        request.params.keyId,
      );
      if (!revoked) {
        throw ProblemError.notFound('There is no such active API key.', {
          code: 'api_key_not_found',
        });
      }
      reply.code(204);
      return null;
    },
  );
}

/**
 * The internal side (service token), for api-gateway and every service's
 * permission guard:
 *
 * - `POST /internal/v1/api-keys/verify` `{key}`: which org a presented key acts
 *   for (`{keyId, orgId, orgType, resellerId}`), or 401 `api_key_invalid` for
 *   anything but a usable key (malformed, unknown, wrong secret, revoked,
 *   expired), all alike.
 * - `GET /internal/v1/orgs/{orgId}/api-keys/{keyId}/permissions`: what the key
 *   may do, with implied reads (G-10), or 404 once it is revoked or expired, as
 *   `/users/{id}/permissions` answers for a person.
 */
export function registerApiKeyInternalRoutes(
  app: Server,
  keys: ApiKeyRepo,
  internalServiceToken: string,
): void {
  function requireToken(header: string | undefined): void {
    const [scheme, presented] = header?.split(' ') ?? [];
    if (
      scheme !== 'Bearer' ||
      presented === undefined ||
      !secretEquals(internalServiceToken, presented)
    ) {
      throw ProblemError.unauthorized('A valid internal service token is required.', {
        code: 'internal_token_invalid',
      });
    }
  }

  app.post(
    '/internal/v1/api-keys/verify',
    {
      config: { public: true },
      schema: {
        body: Type.Object({ key: Type.String({ minLength: 1, maxLength: 128 }) }),
        response: {
          200: Type.Object({
            keyId: Type.String(),
            orgId: Type.String(),
            orgType: Type.Union([
              Type.Literal('master'),
              Type.Literal('reseller'),
              Type.Literal('tenant'),
            ]),
            resellerId: Type.Union([Type.String(), Type.Null()]),
          }),
        },
      },
    },
    async (request) => {
      requireToken(request.headers.authorization);
      const key = await keys.verify(request.body.key);
      if (key === undefined) {
        throw ProblemError.unauthorized('The API key is invalid, revoked or expired.', {
          code: 'api_key_invalid',
        });
      }
      return {
        keyId: key.id,
        orgId: key.orgId,
        orgType: key.orgType,
        resellerId: key.resellerId,
      };
    },
  );

  app.get(
    '/internal/v1/orgs/:orgId/api-keys/:keyId/permissions',
    {
      config: { public: true },
      schema: {
        params: KeyParamsSchema,
        response: { 200: Type.Object({ permissions: Type.Array(Type.String()) }) },
      },
    },
    async (request) => {
      requireToken(request.headers.authorization);
      const key = await keys.findById(request.params.orgId, request.params.keyId);
      if (key === undefined || !isUsable(key)) {
        throw ProblemError.notFound('No such active API key in that organization.', {
          code: 'api_key_not_found',
        });
      }
      const permissions = [...expandPermissions(key.permissions)].filter(apiKeyMayHold).sort();
      return { permissions };
    },
  );
}
