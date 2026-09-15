import { publishAuditEvent } from '@cuc/audit';
import type { DbContext } from '@cuc/db';
import type { Bus } from '@cuc/events';
import { ProblemError, Type, type Server, type Static } from '@cuc/http';

import { InvalidExtensionNumberError } from '../domain/numbering.js';
import {
  ExtensionNotFoundError,
  ExtensionNumberTakenError,
  TenantDomainNotFoundError,
  type ExtensionRepo,
} from '../repo/extension.repo.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });
const ExtensionParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});

const ExtensionSchema = Type.Object({
  id: Type.String(),
  number: Type.String(),
  userId: Type.Union([Type.String(), Type.Null()]),
  displayName: Type.String(),
  callerIdName: Type.Union([Type.String(), Type.Null()]),
  callerIdNumber: Type.Union([Type.String(), Type.Null()]),
  voicemailEnabled: Type.Boolean(),
});
type ExtensionResponse = Static<typeof ExtensionSchema>;

const CreateExtensionBodySchema = Type.Object({
  number: Type.String({ minLength: 1 }),
  userId: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  displayName: Type.String({ minLength: 1, maxLength: 255 }),
  callerIdName: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  callerIdNumber: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  voicemailEnabled: Type.Optional(Type.Boolean()),
});

const UpdateExtensionBodySchema = Type.Object({
  number: Type.Optional(Type.String({ minLength: 1 })),
  userId: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  callerIdName: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  callerIdNumber: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  voicemailEnabled: Type.Optional(Type.Boolean()),
});

const RevealBodySchema = Type.Object({
  /** Free-text justification, stored on the audit event (07 §3.1's precedent for a master's access). */
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
});
const RevealResponseSchema = Type.Object({
  username: Type.String(),
  password: Type.String(),
  realm: Type.String(),
});

function toResponse(extension: {
  id: string;
  number: string;
  userId: string | null;
  displayName: string;
  callerIdName: string | null;
  callerIdNumber: string | null;
  voicemailEnabled: boolean;
}): ExtensionResponse {
  return {
    id: extension.id,
    number: extension.number,
    userId: extension.userId,
    displayName: extension.displayName,
    callerIdName: extension.callerIdName,
    callerIdNumber: extension.callerIdNumber,
    voicemailEnabled: extension.voicemailEnabled,
  };
}

/**
 * Builds the tenant context for one request. The tenant comes from the URL
 * (`/v1/tenants/{tenantId}/…`), not `request.context` alone — that only
 * carries a tenant when this service trusts the `x-internal-*` headers,
 * true only behind api-gateway. Matches `example-service`'s template
 * exactly, including the gap it documents: nothing here yet rejects a
 * request whose trusted context names a *different* tenant than the URL.
 */
function ctxFor(request: {
  readonly context: DbContext;
  readonly params: { readonly tenantId: string };
}): DbContext {
  return { ...request.context, tenantId: request.params.tenantId };
}

function toProblem(error: unknown): ProblemError {
  if (error instanceof InvalidExtensionNumberError) return ProblemError.badRequest(error.message);
  if (error instanceof ExtensionNumberTakenError) {
    return ProblemError.conflict(error.message, { code: 'extension_number_taken' });
  }
  if (error instanceof TenantDomainNotFoundError) {
    return ProblemError.conflict(error.message, { code: 'tenant_domain_not_found' });
  }
  if (error instanceof ExtensionNotFoundError) return ProblemError.notFound(error.message);
  throw error;
}

/**
 * Registers `/v1/tenants/{tenantId}/extensions` (06's pbx-config-service
 * section). Every route declares `permission` and `dataClass` — `@cuc/http`
 * refuses to register one that does not (CLAUDE.md rule 3).
 */
export function registerExtensionRoutes(app: Server, extensions: ExtensionRepo, bus: Bus): void {
  app.get(
    '/v1/tenants/:tenantId/extensions',
    {
      config: { permission: 'extension.manage', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(ExtensionSchema) }) },
      },
    },
    async (request) => ({ rows: (await extensions.list(ctxFor(request))).map(toResponse) }),
  );

  app.get(
    '/v1/tenants/:tenantId/extensions/:id',
    {
      config: { permission: 'extension.manage', dataClass: 'config' },
      schema: { params: ExtensionParamsSchema, response: { 200: ExtensionSchema } },
    },
    async (request) => {
      const found = await extensions.findById(ctxFor(request), request.params.id);
      if (found === undefined) throw ProblemError.notFound('No extension with that id.');
      return toResponse(found);
    },
  );

  app.post(
    '/v1/tenants/:tenantId/extensions',
    {
      config: { permission: 'extension.manage', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        body: CreateExtensionBodySchema,
        response: { 201: ExtensionSchema },
      },
    },
    async (request, reply) => {
      try {
        const created = await extensions.create(ctxFor(request), request.body);
        return reply.status(201).send(toResponse(created));
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.patch(
    '/v1/tenants/:tenantId/extensions/:id',
    {
      config: { permission: 'extension.manage', dataClass: 'config' },
      schema: {
        params: ExtensionParamsSchema,
        body: UpdateExtensionBodySchema,
        response: { 200: ExtensionSchema },
      },
    },
    async (request) => {
      try {
        return toResponse(
          await extensions.update(ctxFor(request), request.params.id, request.body),
        );
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/extensions/:id',
    {
      config: { permission: 'extension.manage', dataClass: 'config' },
      schema: { params: ExtensionParamsSchema },
    },
    async (request, reply) => {
      try {
        await extensions.remove(ctxFor(request), request.params.id);
      } catch (error) {
        throw toProblem(error);
      }
      return reply.status(204).send();
    },
  );

  app.post(
    '/v1/tenants/:tenantId/extensions/:id/reveal',
    {
      // secret.reveal, not extension.manage: 07 §3.2 — the SIP password is
      // `secret` class, write-only outside this one action.
      config: { permission: 'secret.reveal', dataClass: 'secret' },
      schema: {
        params: ExtensionParamsSchema,
        body: RevealBodySchema,
        response: { 200: RevealResponseSchema },
      },
    },
    async (request) => {
      const { actorId, actorType, orgId } = request.context;
      if (actorId === undefined || actorType === undefined || orgId === undefined) {
        throw ProblemError.unauthorized(
          'An identified actor is required to reveal a SIP credential.',
        );
      }

      let revealed;
      try {
        revealed = await extensions.reveal(ctxFor(request), request.params.id);
      } catch (error) {
        throw toProblem(error);
      }

      // 06: "requires a permission and is audited" — a read, not a
      // co-transactional write, so this publishes directly rather than going
      // through the outbox (07 §4).
      await publishAuditEvent(bus, {
        actorType,
        actorId,
        actorOrgId: orgId,
        targetOrgId: request.params.tenantId,
        action: 'extension.credential.revealed',
        resource: request.params.id,
        dataClass: 'secret',
        ...(request.body.reason === undefined ? {} : { reason: request.body.reason }),
        ...(request.ip === undefined ? {} : { ip: request.ip }),
        requestId: request.context.requestId,
      });

      return revealed;
    },
  );
}
