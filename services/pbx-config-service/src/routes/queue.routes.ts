import type { DbContext } from '@cuc/db';
import { ProblemError, Type, type Server } from '@cuc/http';

import { InvalidQueueError } from '../domain/queue.js';
import { QueueNotFoundError, type QueueRepo } from '../repo/queue.repo.js';
import {
  AgentAlreadyTieredError,
  AgentForTierNotFoundError,
  QueueForTierNotFoundError,
  QueueTierNotFoundError,
  type QueueTierRepo,
} from '../repo/queue-tier.repo.js';
import { InvalidAgentError } from '../domain/agent.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });
const QueueParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});
const QueueTierParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  queueId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});
const QueueTiersListParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  queueId: Type.String({ minLength: 1 }),
});

const QueueSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  strategy: Type.String(),
  mohMediaAssetId: Type.Union([Type.String(), Type.Null()]),
  maxWaitSeconds: Type.Number(),
  announcePosition: Type.Boolean(),
  announceFrequencySeconds: Type.Union([Type.Number(), Type.Null()]),
  noAgentDestinationType: Type.Union([Type.String(), Type.Null()]),
  noAgentDestinationId: Type.Union([Type.String(), Type.Null()]),
});

const CreateQueueBodySchema = Type.Object({
  label: Type.String({ minLength: 1 }),
  strategy: Type.String({ minLength: 1 }),
  mohMediaAssetId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  maxWaitSeconds: Type.Number(),
  announcePosition: Type.Boolean(),
  announceFrequencySeconds: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  noAgentDestinationType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  noAgentDestinationId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const UpdateQueueBodySchema = Type.Object({
  label: Type.Optional(Type.String({ minLength: 1 })),
  strategy: Type.Optional(Type.String({ minLength: 1 })),
  mohMediaAssetId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  maxWaitSeconds: Type.Optional(Type.Number()),
  announcePosition: Type.Optional(Type.Boolean()),
  announceFrequencySeconds: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  noAgentDestinationType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  noAgentDestinationId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const QueueTierSchema = Type.Object({
  id: Type.String(),
  queueId: Type.String(),
  agentId: Type.String(),
  level: Type.Number(),
  position: Type.Number(),
});

const AddQueueTierBodySchema = Type.Object({
  agentId: Type.String({ minLength: 1 }),
  level: Type.Optional(Type.Number()),
  position: Type.Optional(Type.Number()),
});

const UpdateQueueTierBodySchema = Type.Object({
  level: Type.Optional(Type.Number()),
  position: Type.Optional(Type.Number()),
});

function ctxFor(request: {
  readonly context: DbContext;
  readonly params: { readonly tenantId: string };
}): DbContext {
  return { ...request.context, tenantId: request.params.tenantId };
}

function toQueueProblem(error: unknown): ProblemError {
  if (error instanceof InvalidQueueError) return ProblemError.badRequest(error.message);
  if (error instanceof QueueNotFoundError) return ProblemError.notFound(error.message);
  throw error;
}

function toTierProblem(error: unknown): ProblemError {
  if (error instanceof InvalidAgentError) return ProblemError.badRequest(error.message);
  if (error instanceof QueueTierNotFoundError) return ProblemError.notFound(error.message);
  if (error instanceof QueueForTierNotFoundError) return ProblemError.badRequest(error.message);
  if (error instanceof AgentForTierNotFoundError) return ProblemError.badRequest(error.message);
  if (error instanceof AgentAlreadyTieredError) return ProblemError.conflict(error.message);
  throw error;
}

/**
 * Registers `/v1/tenants/{tenantId}/queues` and its nested `/tiers`
 * sub-resource (S2-13; 05 §3.3). `queue.manage` is already in the
 * permission catalog (07 §3.3), the same pre-seeded-permission precedent
 * `ring-group.routes.ts`'s own doc comment flags for `group.manage`.
 */
export function registerQueueRoutes(app: Server, queues: QueueRepo, tiers: QueueTierRepo): void {
  app.get(
    '/v1/tenants/:tenantId/queues',
    {
      config: { permission: 'queue.read', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(QueueSchema) }) },
      },
    },
    async (request) => ({ rows: await queues.list(ctxFor(request)) }),
  );

  app.get(
    '/v1/tenants/:tenantId/queues/:id',
    {
      config: { permission: 'queue.read', dataClass: 'config' },
      schema: { params: QueueParamsSchema, response: { 200: QueueSchema } },
    },
    async (request) => {
      const found = await queues.findById(ctxFor(request), request.params.id);
      if (found === undefined) throw ProblemError.notFound('No queue with that id.');
      return found;
    },
  );

  app.post(
    '/v1/tenants/:tenantId/queues',
    {
      config: { permission: 'queue.manage', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        body: CreateQueueBodySchema,
        response: { 201: QueueSchema },
      },
    },
    async (request, reply) => {
      try {
        const created = await queues.create(ctxFor(request), request.body);
        return reply.status(201).send(created);
      } catch (error) {
        throw toQueueProblem(error);
      }
    },
  );

  app.patch(
    '/v1/tenants/:tenantId/queues/:id',
    {
      config: { permission: 'queue.manage', dataClass: 'config' },
      schema: {
        params: QueueParamsSchema,
        body: UpdateQueueBodySchema,
        response: { 200: QueueSchema },
      },
    },
    async (request) => {
      try {
        return await queues.update(ctxFor(request), request.params.id, request.body);
      } catch (error) {
        throw toQueueProblem(error);
      }
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/queues/:id',
    {
      config: { permission: 'queue.manage', dataClass: 'config' },
      schema: { params: QueueParamsSchema },
    },
    async (request, reply) => {
      try {
        await queues.remove(ctxFor(request), request.params.id);
      } catch (error) {
        throw toQueueProblem(error);
      }
      return reply.status(204).send();
    },
  );

  app.get(
    '/v1/tenants/:tenantId/queues/:queueId/tiers',
    {
      config: { permission: 'queue.read', dataClass: 'config' },
      schema: {
        params: QueueTiersListParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(QueueTierSchema) }) },
      },
    },
    async (request) => ({
      rows: await tiers.listForQueue(
        { ...request.context, tenantId: request.params.tenantId },
        request.params.queueId,
      ),
    }),
  );

  app.post(
    '/v1/tenants/:tenantId/queues/:queueId/tiers',
    {
      config: { permission: 'queue.manage', dataClass: 'config' },
      schema: {
        params: QueueTiersListParamsSchema,
        body: AddQueueTierBodySchema,
        response: { 201: QueueTierSchema },
      },
    },
    async (request, reply) => {
      try {
        const created = await tiers.add(
          { ...request.context, tenantId: request.params.tenantId },
          { queueId: request.params.queueId, ...request.body },
        );
        return reply.status(201).send(created);
      } catch (error) {
        throw toTierProblem(error);
      }
    },
  );

  app.patch(
    '/v1/tenants/:tenantId/queues/:queueId/tiers/:id',
    {
      config: { permission: 'queue.manage', dataClass: 'config' },
      schema: {
        params: QueueTierParamsSchema,
        body: UpdateQueueTierBodySchema,
        response: { 200: QueueTierSchema },
      },
    },
    async (request) => {
      try {
        return await tiers.update(
          { ...request.context, tenantId: request.params.tenantId },
          request.params.id,
          request.body,
        );
      } catch (error) {
        throw toTierProblem(error);
      }
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/queues/:queueId/tiers/:id',
    {
      config: { permission: 'queue.manage', dataClass: 'config' },
      schema: { params: QueueTierParamsSchema },
    },
    async (request, reply) => {
      try {
        await tiers.remove(
          { ...request.context, tenantId: request.params.tenantId },
          request.params.id,
        );
      } catch (error) {
        throw toTierProblem(error);
      }
      return reply.status(204).send();
    },
  );
}
