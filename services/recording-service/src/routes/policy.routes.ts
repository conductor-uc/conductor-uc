import type { DbContext } from '@cuc/db';
import { clientIpOf, ProblemError, Type, type RequestContext, type Server } from '@cuc/http';
import type { Logger } from '@cuc/logger';
import type { Storage } from '@cuc/storage';

import type { AccessClient } from '../access.js';
import { auditFor, requireForTenant, resolveCaller, type Caller } from '../authorize.js';
import { InvalidPolicyError, validatePolicy, type Policy } from '../domain/policy.js';
import { InvalidRetentionError } from '../domain/retention.js';
import { PolicyConflictError, PolicyNotFoundError, type PolicyRepo } from '../repo/policy.repo.js';
import type { SettingsRepo } from '../repo/settings.repo.js';
import { applyLifecycleBackstop } from '../retention.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });
const PolicyParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});

const ScopeTypeSchema = Type.Union([
  Type.Literal('tenant'),
  Type.Literal('extension'),
  Type.Literal('queue'),
  Type.Literal('did'),
]);
const DirectionSchema = Type.Union([
  Type.Literal('any'),
  Type.Literal('inbound'),
  Type.Literal('outbound'),
  Type.Literal('internal'),
]);
const ActionSchema = Type.Union([Type.Literal('record'), Type.Literal('no_record')]);

const PolicySchema = Type.Object({
  id: Type.String(),
  scopeType: ScopeTypeSchema,
  scopeId: Type.String(),
  direction: DirectionSchema,
  action: ActionSchema,
  announce: Type.Boolean(),
  consentAssetId: Type.Union([Type.String(), Type.Null()]),
});
const PolicyBodySchema = Type.Object({
  scopeType: ScopeTypeSchema,
  /** Required for extension, queue and DID scopes; a tenant-wide policy takes none. */
  scopeId: Type.Optional(Type.String({ maxLength: 36 })),
  direction: Type.Optional(DirectionSchema),
  action: ActionSchema,
  announce: Type.Optional(Type.Boolean()),
  consentAssetId: Type.Optional(Type.Union([Type.String({ maxLength: 36 }), Type.Null()])),
});
const SettingsSchema = Type.Object({
  retentionDays: Type.Number(),
  /** S5-12: refuse a call when the recording its rules may require cannot be set up. */
  failClosed: Type.Boolean(),
});
/** Either or both; what is left out keeps its value. */
const SettingsBodySchema = Type.Object({
  retentionDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 3650 })),
  failClosed: Type.Optional(Type.Boolean()),
});

function ctxFor(request: {
  readonly context: DbContext;
  readonly params: { readonly tenantId: string };
}): DbContext {
  return { ...request.context, tenantId: request.params.tenantId };
}

function toProblem(error: unknown): ProblemError {
  if (error instanceof InvalidPolicyError) return ProblemError.badRequest(error.message);
  if (error instanceof InvalidRetentionError) return ProblemError.badRequest(error.message);
  if (error instanceof PolicyNotFoundError) return ProblemError.notFound(error.message);
  if (error instanceof PolicyConflictError) {
    return ProblemError.conflict(error.message, { code: 'policy_exists' });
  }
  throw error;
}

function toResponse(policy: Policy): Policy {
  return { ...policy };
}

export interface PolicyRoutesDeps {
  readonly policies: PolicyRepo;
  readonly settings: SettingsRepo;
  readonly access: AccessClient;
  readonly storage: Storage;
  readonly logger: Logger;
}

/**
 * `/v1/tenants/{t}/recording-policies` and `/recording-settings` (S5-01, S5-05; 06's
 * recording-service public API). Configuration, so `dataClass: 'config'`. The reads need
 * `recording.policy.read` and the writes `recording.policy.manage` (07 §3.3: tenant admin; the
 * management permission implies the read, G-10) across the tenant, checked per request with
 * `@cuc/authz`. Each write is audited in the same transaction as the write.
 */
export function registerPolicyRoutes(app: Server, deps: PolicyRoutesDeps): void {
  const { policies, settings, access, storage, logger } = deps;

  async function authorized(
    request: {
      readonly context: RequestContext;
      readonly params: { readonly tenantId: string };
      readonly ip: string;
    },
    permission: 'recording.policy.read' | 'recording.policy.manage' = 'recording.policy.manage',
  ): Promise<Caller> {
    const caller = await resolveCaller(
      request.context,
      request.params.tenantId,
      clientIpOf(request),
      access,
    );
    requireForTenant(caller, permission);
    return caller;
  }

  app.get(
    '/v1/tenants/:tenantId/recording-policies',
    {
      config: { permission: 'recording.policy.read', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(PolicySchema) }) },
      },
    },
    async (request) => {
      await authorized(request, 'recording.policy.read');
      return { rows: (await policies.list(ctxFor(request))).map(toResponse) };
    },
  );

  app.post(
    '/v1/tenants/:tenantId/recording-policies',
    {
      config: { permission: 'recording.policy.manage', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        body: PolicyBodySchema,
        response: { 201: PolicySchema },
      },
    },
    async (request, reply) => {
      const caller = await authorized(request);
      try {
        const valid = validatePolicy(
          {
            ...request.body,
            direction: request.body.direction ?? 'any',
            announce: request.body.announce ?? false,
          },
          request.params.tenantId,
        );
        const created = await policies.create(
          ctxFor(request),
          valid,
          auditFor(caller, {
            action: 'recording.policy.created',
            resource: 'recording-policy',
            dataClass: 'config',
          }),
        );
        return reply.status(201).send(toResponse(created));
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.put(
    '/v1/tenants/:tenantId/recording-policies/:id',
    {
      config: { permission: 'recording.policy.manage', dataClass: 'config' },
      schema: {
        params: PolicyParamsSchema,
        body: PolicyBodySchema,
        response: { 200: PolicySchema },
      },
    },
    async (request) => {
      const caller = await authorized(request);
      try {
        const valid = validatePolicy(
          {
            ...request.body,
            direction: request.body.direction ?? 'any',
            announce: request.body.announce ?? false,
          },
          request.params.tenantId,
        );
        return toResponse(
          await policies.update(
            ctxFor(request),
            request.params.id,
            valid,
            auditFor(caller, {
              action: 'recording.policy.updated',
              resource: 'recording-policy',
              dataClass: 'config',
            }),
          ),
        );
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/recording-policies/:id',
    {
      config: { permission: 'recording.policy.manage', dataClass: 'config' },
      schema: { params: PolicyParamsSchema },
    },
    async (request, reply) => {
      const caller = await authorized(request);
      try {
        await policies.remove(
          ctxFor(request),
          request.params.id,
          auditFor(caller, {
            action: 'recording.policy.deleted',
            resource: 'recording-policy',
            dataClass: 'config',
          }),
        );
      } catch (error) {
        throw toProblem(error);
      }
      return reply.status(204).send();
    },
  );

  app.get(
    '/v1/tenants/:tenantId/recording-settings',
    {
      config: { permission: 'recording.policy.read', dataClass: 'config' },
      schema: { params: TenantParamsSchema, response: { 200: SettingsSchema } },
    },
    async (request) => {
      await authorized(request, 'recording.policy.read');
      return settings.settings(ctxFor(request));
    },
  );

  app.put(
    '/v1/tenants/:tenantId/recording-settings',
    {
      config: { permission: 'recording.policy.manage', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        body: SettingsBodySchema,
        response: { 200: SettingsSchema },
      },
    },
    async (request) => {
      const caller = await authorized(request);
      const { retentionDays, failClosed } = request.body;
      if (retentionDays === undefined && failClosed === undefined) {
        throw ProblemError.badRequest('Give retentionDays, failClosed, or both.');
      }
      try {
        const saved = await settings.update(
          ctxFor(request),
          { retentionDays, failClosed },
          auditFor(caller, {
            // A retention-only change keeps the action it always had.
            action:
              failClosed === undefined
                ? 'recording.retention.updated'
                : 'recording.settings.updated',
            resource: 'recording-settings',
            dataClass: 'config',
          }),
        );
        if (retentionDays !== undefined) {
          await applyLifecycleBackstop(
            storage,
            logger,
            request.params.tenantId,
            saved.retentionDays,
          );
        }
        return saved;
      } catch (error) {
        throw toProblem(error);
      }
    },
  );
}
