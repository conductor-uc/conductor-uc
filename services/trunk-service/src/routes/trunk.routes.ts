import { publishAuditEvent } from '@cuc/audit';
import type { DbContext } from '@cuc/db';
import type { Bus } from '@cuc/events';
import { ProblemError, Type, type Server, type Static } from '@cuc/http';

import {
  InvalidCidrError,
  InvalidTrunkConfigError,
  AUTH_MODES,
  TRANSPORTS,
} from '../domain/trunk.js';
import {
  TenantResellerNotFoundError,
  TrunkHasNoCredentialError,
  TrunkIpNotFoundError,
  TrunkNameTakenError,
  TrunkNotFoundError,
  type TrunkRepo,
} from '../repo/trunk.repo.js';
import type { TelephonyConfigClient } from '../telephony-config-client.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });
const TrunkParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});
const TrunkIpParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
  ipId: Type.String({ minLength: 1 }),
});

const AuthModeSchema = Type.Union(AUTH_MODES.map((mode) => Type.Literal(mode)));
const TransportSchema = Type.Union(TRANSPORTS.map((transport) => Type.Literal(transport)));

const CallerIdPolicySchema = Type.Object({
  name: Type.Union([Type.String(), Type.Null()]),
  number: Type.Union([Type.String(), Type.Null()]),
});

const TrunkSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  authMode: AuthModeSchema,
  host: Type.String(),
  port: Type.Integer(),
  transport: Type.String(),
  username: Type.Union([Type.String(), Type.Null()]),
  fromDomain: Type.Union([Type.String(), Type.Null()]),
  codecs: Type.Array(Type.String()),
  maxChannels: Type.Union([Type.Integer(), Type.Null()]),
  callerIdPolicy: Type.Union([CallerIdPolicySchema, Type.Null()]),
  status: Type.String(),
});
type TrunkResponse = Static<typeof TrunkSchema>;

const CreateTrunkBodySchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }),
  authMode: AuthModeSchema,
  host: Type.String({ minLength: 1 }),
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  transport: TransportSchema,
  username: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  secret: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  fromDomain: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  codecs: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  maxChannels: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
  callerIdPolicy: Type.Optional(Type.Union([CallerIdPolicySchema, Type.Null()])),
});

const UpdateTrunkBodySchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  authMode: Type.Optional(AuthModeSchema),
  host: Type.Optional(Type.String({ minLength: 1 })),
  port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
  transport: Type.Optional(TransportSchema),
  username: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  secret: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  fromDomain: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  codecs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
  maxChannels: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
  callerIdPolicy: Type.Optional(Type.Union([CallerIdPolicySchema, Type.Null()])),
  status: Type.Optional(Type.String({ minLength: 1 })),
});

const TrunkIpSchema = Type.Object({ id: Type.String(), cidr: Type.String() });
const AddTrunkIpBodySchema = Type.Object({ cidr: Type.String({ minLength: 1 }) });

const RevealBodySchema = Type.Object({
  /** Free-text justification, stored on the audit event (07 §3.1's precedent for a master's access). */
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
});
const RevealResponseSchema = Type.Object({ username: Type.String(), secret: Type.String() });

const RegistrationStatusSchema = Type.Union([
  Type.Literal('registered'),
  Type.Literal('registering'),
  Type.Literal('failed'),
  Type.Literal('not_registered'),
  Type.Literal('not_applicable'),
]);
const StatusResponseSchema = Type.Object({ registrationStatus: RegistrationStatusSchema });

function toResponse(trunk: {
  id: string;
  name: string;
  authMode: string;
  host: string;
  port: number;
  transport: string;
  username: string | null;
  fromDomain: string | null;
  codecs: readonly string[];
  maxChannels: number | null;
  callerIdPolicy: { name: string | null; number: string | null } | null;
  status: string;
}): TrunkResponse {
  return {
    id: trunk.id,
    name: trunk.name,
    authMode: trunk.authMode as TrunkResponse['authMode'],
    host: trunk.host,
    port: trunk.port,
    transport: trunk.transport,
    username: trunk.username,
    fromDomain: trunk.fromDomain,
    codecs: [...trunk.codecs],
    maxChannels: trunk.maxChannels,
    callerIdPolicy: trunk.callerIdPolicy,
    status: trunk.status,
  };
}

/**
 * Builds the tenant context for one request. The tenant comes from the URL
 * (`/v1/tenants/{tenantId}/…`), not `request.context` alone — matches
 * pbx-config-service's `extension.routes.ts` precedent exactly, including the
 * gap it documents: nothing here yet rejects a request whose trusted context
 * names a *different* tenant than the URL.
 */
function ctxFor(request: {
  readonly context: DbContext;
  readonly params: { readonly tenantId: string };
}): DbContext {
  return { ...request.context, tenantId: request.params.tenantId };
}

function toProblem(error: unknown): ProblemError {
  if (error instanceof InvalidTrunkConfigError) return ProblemError.badRequest(error.message);
  if (error instanceof InvalidCidrError) return ProblemError.badRequest(error.message);
  if (error instanceof TrunkNameTakenError) {
    return ProblemError.conflict(error.message, { code: 'trunk_name_taken' });
  }
  if (error instanceof TenantResellerNotFoundError) {
    return ProblemError.conflict(error.message, { code: 'tenant_reseller_not_found' });
  }
  if (error instanceof TrunkHasNoCredentialError) {
    return ProblemError.conflict(error.message, { code: 'trunk_has_no_credential' });
  }
  if (error instanceof TrunkNotFoundError) return ProblemError.notFound(error.message);
  if (error instanceof TrunkIpNotFoundError) return ProblemError.notFound(error.message);
  throw error;
}

/**
 * Registers `/v1/tenants/{tenantId}/trunks` (06's trunk-service section).
 * Every route declares `permission` and `dataClass` — `@cuc/http` refuses to
 * register one that does not (CLAUDE.md rule 3).
 *
 * Resellers manage their tenants' trunks (`trunk.manage`/`config`, in the
 * built-in role catalog — `@cuc/authz`'s `roles.ts`); editing by a tenant
 * admin requires the `trunk.manage` grant (06). The list and view routes
 * declare `trunk.read` (G-10), which `trunk.manage` implies, so the support
 * roles can view trunks without being able to change them; the writes
 * declare `trunk.manage`.
 */
export function registerTrunkRoutes(
  app: Server,
  trunks: TrunkRepo,
  bus: Bus,
  telephony: TelephonyConfigClient,
): void {
  app.get(
    '/v1/tenants/:tenantId/trunks',
    {
      config: { permission: 'trunk.read', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(TrunkSchema) }) },
      },
    },
    async (request) => ({ rows: (await trunks.list(ctxFor(request))).map(toResponse) }),
  );

  app.get(
    '/v1/tenants/:tenantId/trunks/:id',
    {
      config: { permission: 'trunk.read', dataClass: 'config' },
      schema: { params: TrunkParamsSchema, response: { 200: TrunkSchema } },
    },
    async (request) => {
      const found = await trunks.findById(ctxFor(request), request.params.id);
      if (found === undefined) throw ProblemError.notFound('No trunk with that id.');
      return toResponse(found);
    },
  );

  app.post(
    '/v1/tenants/:tenantId/trunks',
    {
      config: { permission: 'trunk.manage', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        body: CreateTrunkBodySchema,
        response: { 201: TrunkSchema },
      },
    },
    async (request, reply) => {
      try {
        const created = await trunks.create(ctxFor(request), request.body);
        return reply.status(201).send(toResponse(created));
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.patch(
    '/v1/tenants/:tenantId/trunks/:id',
    {
      config: { permission: 'trunk.manage', dataClass: 'config' },
      schema: {
        params: TrunkParamsSchema,
        body: UpdateTrunkBodySchema,
        response: { 200: TrunkSchema },
      },
    },
    async (request) => {
      try {
        return toResponse(await trunks.update(ctxFor(request), request.params.id, request.body));
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/trunks/:id',
    {
      config: { permission: 'trunk.manage', dataClass: 'config' },
      schema: { params: TrunkParamsSchema },
    },
    async (request, reply) => {
      try {
        await trunks.remove(ctxFor(request), request.params.id);
      } catch (error) {
        throw toProblem(error);
      }
      return reply.status(204).send();
    },
  );

  app.get(
    '/v1/tenants/:tenantId/trunks/:id/ips',
    {
      config: { permission: 'trunk.read', dataClass: 'config' },
      schema: {
        params: TrunkParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(TrunkIpSchema) }) },
      },
    },
    async (request) => ({ rows: await trunks.listIps(ctxFor(request), request.params.id) }),
  );

  app.post(
    '/v1/tenants/:tenantId/trunks/:id/ips',
    {
      config: { permission: 'trunk.manage', dataClass: 'config' },
      schema: {
        params: TrunkParamsSchema,
        body: AddTrunkIpBodySchema,
        response: { 201: TrunkIpSchema },
      },
    },
    async (request, reply) => {
      try {
        const created = await trunks.addIp(ctxFor(request), request.params.id, request.body.cidr);
        return reply.status(201).send(created);
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/trunks/:id/ips/:ipId',
    {
      config: { permission: 'trunk.manage', dataClass: 'config' },
      schema: { params: TrunkIpParamsSchema },
    },
    async (request, reply) => {
      try {
        await trunks.removeIp(ctxFor(request), request.params.id, request.params.ipId);
      } catch (error) {
        throw toProblem(error);
      }
      return reply.status(204).send();
    },
  );

  app.get(
    '/v1/tenants/:tenantId/trunks/:id/status',
    {
      // 06: "returns registration state (read from OpenSIPs via
      // telephony-config's internal API)" — trunk config, not a secret, so
      // the ordinary trunk.manage/config contract applies.
      config: { permission: 'trunk.read', dataClass: 'config' },
      schema: { params: TrunkParamsSchema, response: { 200: StatusResponseSchema } },
    },
    async (request) => {
      const found = await trunks.findById(ctxFor(request), request.params.id);
      if (found === undefined) throw ProblemError.notFound('No trunk with that id.');

      const status = await telephony.findStatus(request.params.tenantId, request.params.id);
      return { registrationStatus: status?.status ?? 'not_registered' };
    },
  );

  app.post(
    '/v1/tenants/:tenantId/trunks/:id/reveal',
    {
      // secret.reveal, not trunk.manage: 07 §3.2 — the register secret is
      // `secret` class, write-only outside this one action.
      config: { permission: 'secret.reveal', dataClass: 'secret' },
      schema: {
        params: TrunkParamsSchema,
        body: RevealBodySchema,
        response: { 200: RevealResponseSchema },
      },
    },
    async (request) => {
      const { actorId, actorType, orgId } = request.context;
      if (actorId === undefined || actorType === undefined || orgId === undefined) {
        throw ProblemError.unauthorized(
          'An identified actor is required to reveal a trunk credential.',
        );
      }

      let revealed;
      try {
        revealed = await trunks.reveal(ctxFor(request), request.params.id);
      } catch (error) {
        throw toProblem(error);
      }

      // 06-style precedent (S1-09): a read, not a co-transactional write, so
      // this publishes directly rather than going through the outbox (07 §4).
      await publishAuditEvent(bus, {
        actorType,
        actorId,
        actorOrgId: orgId,
        targetOrgId: request.params.tenantId,
        action: 'trunk.credential.revealed',
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
