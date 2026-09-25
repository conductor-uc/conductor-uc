import type { DbContext } from '@cuc/db';
import { ProblemError, Type, type Server, type Static } from '@cuc/http';

import { InvalidE164Error } from '../domain/dids.js';
import {
  DidNotFoundError,
  DidNumberTakenError,
  ExtensionDestinationNotFoundError,
  TrunkNotFoundError,
  type DidRepo,
} from '../repo/did.repo.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });
const DidParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});

const DestinationTypeSchema = Type.Union([
  Type.Literal('extension'),
  Type.Literal('ring_group'),
  Type.Literal('flow'),
  Type.Literal('queue'),
  Type.Literal('conference'),
  Type.Literal('voicemail'),
]);

const DidSchema = Type.Object({
  id: Type.String(),
  e164: Type.String(),
  trunkId: Type.String(),
  destinationType: DestinationTypeSchema,
  destinationId: Type.String(),
});
type DidResponse = Static<typeof DidSchema>;

const CreateDidBodySchema = Type.Object({
  e164: Type.String({ minLength: 1 }),
  trunkId: Type.String({ minLength: 1 }),
  destinationType: DestinationTypeSchema,
  destinationId: Type.String({ minLength: 1 }),
});

const UpdateDidBodySchema = Type.Object({
  trunkId: Type.Optional(Type.String({ minLength: 1 })),
  destinationType: Type.Optional(DestinationTypeSchema),
  destinationId: Type.Optional(Type.String({ minLength: 1 })),
});

function toResponse(did: {
  id: string;
  e164: string;
  trunkId: string;
  destinationType: string;
  destinationId: string;
}): DidResponse {
  return {
    id: did.id,
    e164: did.e164,
    trunkId: did.trunkId,
    destinationType: did.destinationType as DidResponse['destinationType'],
    destinationId: did.destinationId,
  };
}

function ctxFor(request: {
  readonly context: DbContext;
  readonly params: { readonly tenantId: string };
}): DbContext {
  return { ...request.context, tenantId: request.params.tenantId };
}

function toProblem(error: unknown): ProblemError {
  if (error instanceof InvalidE164Error) return ProblemError.badRequest(error.message);
  if (error instanceof DidNumberTakenError) {
    return ProblemError.conflict(error.message, { code: 'did_number_taken' });
  }
  if (error instanceof TrunkNotFoundError) {
    return ProblemError.badRequest(error.message, { code: 'trunk_not_found' });
  }
  if (error instanceof ExtensionDestinationNotFoundError) {
    return ProblemError.badRequest(error.message, { code: 'destination_not_found' });
  }
  if (error instanceof DidNotFoundError) return ProblemError.notFound(error.message);
  throw error;
}

/**
 * Registers `/v1/tenants/{tenantId}/dids` (S2-03; 05 §3.3). Every route
 * declares `permission` and `dataClass` — `@cuc/http` refuses to register one
 * that does not (CLAUDE.md rule 3). `did.manage` is already in the catalog
 * (`@cuc/authz`'s `PERMISSION_CATALOG`/`roles.ts`) — S1-06 added it alongside
 * every other `*.manage` permission before this task ever needed one.
 */
export function registerDidRoutes(app: Server, dids: DidRepo): void {
  app.get(
    '/v1/tenants/:tenantId/dids',
    {
      config: { permission: 'did.read', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(DidSchema) }) },
      },
    },
    async (request) => ({ rows: (await dids.list(ctxFor(request))).map(toResponse) }),
  );

  app.get(
    '/v1/tenants/:tenantId/dids/:id',
    {
      config: { permission: 'did.read', dataClass: 'config' },
      schema: { params: DidParamsSchema, response: { 200: DidSchema } },
    },
    async (request) => {
      const found = await dids.findById(ctxFor(request), request.params.id);
      if (found === undefined) throw ProblemError.notFound('No DID with that id.');
      return toResponse(found);
    },
  );

  app.post(
    '/v1/tenants/:tenantId/dids',
    {
      config: { permission: 'did.manage', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        body: CreateDidBodySchema,
        response: { 201: DidSchema },
      },
    },
    async (request, reply) => {
      try {
        const created = await dids.create(ctxFor(request), request.body);
        return reply.status(201).send(toResponse(created));
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.patch(
    '/v1/tenants/:tenantId/dids/:id',
    {
      config: { permission: 'did.manage', dataClass: 'config' },
      schema: {
        params: DidParamsSchema,
        body: UpdateDidBodySchema,
        response: { 200: DidSchema },
      },
    },
    async (request) => {
      try {
        return toResponse(await dids.update(ctxFor(request), request.params.id, request.body));
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/dids/:id',
    {
      config: { permission: 'did.manage', dataClass: 'config' },
      schema: { params: DidParamsSchema },
    },
    async (request, reply) => {
      try {
        await dids.remove(ctxFor(request), request.params.id);
      } catch (error) {
        throw toProblem(error);
      }
      return reply.status(204).send();
    },
  );
}
