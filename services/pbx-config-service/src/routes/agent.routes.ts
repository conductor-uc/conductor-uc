import type { DbContext } from '@cuc/db';
import { ProblemError, Type, type Server } from '@cuc/http';

import { InvalidAgentError } from '../domain/agent.js';
import {
  AgentExtensionNotFoundError,
  AgentNotFoundError,
  ExtensionAlreadyAgentError,
  type AgentRepo,
} from '../repo/agent.repo.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });
const AgentParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});

const AgentSchema = Type.Object({
  id: Type.String(),
  extensionId: Type.String(),
  maxNoAnswer: Type.Number(),
  wrapUpSeconds: Type.Number(),
  rejectDelaySeconds: Type.Number(),
});

const CreateAgentBodySchema = Type.Object({
  extensionId: Type.String({ minLength: 1 }),
  maxNoAnswer: Type.Optional(Type.Number()),
  wrapUpSeconds: Type.Optional(Type.Number()),
  rejectDelaySeconds: Type.Optional(Type.Number()),
});

const UpdateAgentBodySchema = Type.Object({
  maxNoAnswer: Type.Optional(Type.Number()),
  wrapUpSeconds: Type.Optional(Type.Number()),
  rejectDelaySeconds: Type.Optional(Type.Number()),
});

function ctxFor(request: {
  readonly context: DbContext;
  readonly params: { readonly tenantId: string };
}): DbContext {
  return { ...request.context, tenantId: request.params.tenantId };
}

function toProblem(error: unknown): ProblemError {
  if (error instanceof InvalidAgentError) return ProblemError.badRequest(error.message);
  if (error instanceof AgentNotFoundError) return ProblemError.notFound(error.message);
  if (error instanceof AgentExtensionNotFoundError) return ProblemError.badRequest(error.message);
  if (error instanceof ExtensionAlreadyAgentError) return ProblemError.conflict(error.message);
  throw error;
}

/**
 * Registers `/v1/tenants/{tenantId}/agents` (S2-13; 05 §3.3). Same
 * `queue.manage` permission as `queue.routes.ts` — an agent identity is
 * queue config, not a distinct permission scope of its own (07 §3.3 lists
 * no separate `agent.manage`).
 */
export function registerAgentRoutes(app: Server, agents: AgentRepo): void {
  app.get(
    '/v1/tenants/:tenantId/agents',
    {
      config: { permission: 'queue.read', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(AgentSchema) }) },
      },
    },
    async (request) => ({ rows: await agents.list(ctxFor(request)) }),
  );

  app.get(
    '/v1/tenants/:tenantId/agents/:id',
    {
      config: { permission: 'queue.read', dataClass: 'config' },
      schema: { params: AgentParamsSchema, response: { 200: AgentSchema } },
    },
    async (request) => {
      const found = await agents.findById(ctxFor(request), request.params.id);
      if (found === undefined) throw ProblemError.notFound('No agent with that id.');
      return found;
    },
  );

  app.post(
    '/v1/tenants/:tenantId/agents',
    {
      config: { permission: 'queue.manage', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        body: CreateAgentBodySchema,
        response: { 201: AgentSchema },
      },
    },
    async (request, reply) => {
      try {
        const created = await agents.create(ctxFor(request), request.body);
        return reply.status(201).send(created);
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.patch(
    '/v1/tenants/:tenantId/agents/:id',
    {
      config: { permission: 'queue.manage', dataClass: 'config' },
      schema: {
        params: AgentParamsSchema,
        body: UpdateAgentBodySchema,
        response: { 200: AgentSchema },
      },
    },
    async (request) => {
      try {
        return await agents.update(ctxFor(request), request.params.id, request.body);
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/agents/:id',
    {
      config: { permission: 'queue.manage', dataClass: 'config' },
      schema: { params: AgentParamsSchema },
    },
    async (request, reply) => {
      try {
        await agents.remove(ctxFor(request), request.params.id);
      } catch (error) {
        throw toProblem(error);
      }
      return reply.status(204).send();
    },
  );
}
