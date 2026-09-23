import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { isDuplicateKeyError, requireTenant } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import { validateTierLevel, validateTierPosition } from '../domain/agent.js';
import { pbxEvents } from '../events.js';
import type { PbxConfigServiceDb } from '../schema.js';

export interface QueueTier {
  readonly id: string;
  readonly tenantId: string;
  readonly queueId: string;
  readonly agentId: string;
  readonly level: number;
  readonly position: number;
}

export interface AddQueueTierInput {
  readonly queueId: string;
  readonly agentId: string;
  readonly level?: number;
  readonly position?: number;
}

export interface UpdateQueueTierInput {
  readonly level?: number;
  readonly position?: number;
}

const DEFAULT_LEVEL = 1;
const DEFAULT_POSITION = 1;

export class QueueTierNotFoundError extends Error {
  override readonly name = 'QueueTierNotFoundError';
}

export class QueueForTierNotFoundError extends Error {
  override readonly name = 'QueueForTierNotFoundError';
}

export class AgentForTierNotFoundError extends Error {
  override readonly name = 'AgentForTierNotFoundError';
}

/** The (queue, agent) pair already has a tier row — `(queue_id, agent_id)` is unique (`006_add_queues.ts`). */
export class AgentAlreadyTieredError extends Error {
  override readonly name = 'AgentAlreadyTieredError';
}

interface QueueTierRow {
  id: string;
  tenant_id: string;
  queue_id: string;
  agent_id: string;
  level: number;
  position: number;
}

function toQueueTier(row: QueueTierRow): QueueTier {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    queueId: row.queue_id,
    agentId: row.agent_id,
    level: row.level,
    position: row.position,
  };
}

async function assertQueueExists(
  db: Database<PbxConfigServiceDb>,
  ctx: DbContext,
  queueId: string,
): Promise<void> {
  const found = await db
    .scoped(ctx)
    .selectFrom('queues')
    .select('id')
    .where('id', '=', queueId)
    .executeTakeFirst();
  if (found === undefined) {
    throw new QueueForTierNotFoundError(`No queue with id '${queueId}' in this tenant.`);
  }
}

async function assertAgentExists(
  db: Database<PbxConfigServiceDb>,
  ctx: DbContext,
  agentId: string,
): Promise<void> {
  const found = await db
    .scoped(ctx)
    .selectFrom('agents')
    .select('id')
    .where('id', '=', agentId)
    .executeTakeFirst();
  if (found === undefined) {
    throw new AgentForTierNotFoundError(`No agent with id '${agentId}' in this tenant.`);
  }
}

/**
 * Data access for queue tiers — the agent<->queue join (S2-13; 05 §3.3).
 * Every query goes through `scoped(ctx)` (CLAUDE.md rule 2). Publishes
 * `pbx.queue_tier.*`, thin (both ids, `events.ts`'s own doc comment on why).
 */
export function createQueueTierRepo(db: Database<PbxConfigServiceDb>) {
  return {
    listForQueue: (ctx: DbContext, queueId: string): Promise<QueueTier[]> =>
      db
        .scoped(ctx)
        .selectFrom('queue_tiers')
        .selectAll()
        .where('queue_id', '=', queueId)
        .orderBy('level', 'asc')
        .orderBy('position', 'asc')
        .execute()
        .then((rows) => rows.map(toQueueTier)),

    listForAgent: (ctx: DbContext, agentId: string): Promise<QueueTier[]> =>
      db
        .scoped(ctx)
        .selectFrom('queue_tiers')
        .selectAll()
        .where('agent_id', '=', agentId)
        .orderBy('level', 'asc')
        .execute()
        .then((rows) => rows.map(toQueueTier)),

    async add(ctx: DbContext, input: AddQueueTierInput): Promise<QueueTier> {
      const { tenantId } = requireTenant(ctx);
      const level = validateTierLevel(input.level ?? DEFAULT_LEVEL);
      const position = validateTierPosition(input.position ?? DEFAULT_POSITION);
      await assertQueueExists(db, ctx, input.queueId);
      await assertAgentExists(db, ctx, input.agentId);

      const id = randomUUID();
      const now = new Date();

      try {
        await db.scoped(ctx).transaction(async (trx, raw) => {
          await trx
            .insertInto('queue_tiers')
            .values({
              id,
              queue_id: input.queueId,
              agent_id: input.agentId,
              level,
              position,
              created_at: now,
            })
            .execute();

          await enqueueEvent(raw, pbxEvents, {
            type: 'pbx.queue_tier.added',
            data: { queueId: input.queueId, agentId: input.agentId },
            orgContext: { tenantId },
            ...(ctx.actorId === undefined || ctx.orgId === undefined
              ? {}
              : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
            ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
          });
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new AgentAlreadyTieredError(
            `Agent '${input.agentId}' is already tiered into queue '${input.queueId}'.`,
          );
        }
        throw error;
      }

      return { id, tenantId, queueId: input.queueId, agentId: input.agentId, level, position };
    },

    async update(ctx: DbContext, id: string, input: UpdateQueueTierInput): Promise<QueueTier> {
      const { tenantId } = requireTenant(ctx);
      const existing = await db
        .scoped(ctx)
        .selectFrom('queue_tiers')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing === undefined)
        throw new QueueTierNotFoundError(`No queue tier with id '${id}'.`);
      const current = toQueueTier(existing);

      const level = input.level === undefined ? current.level : validateTierLevel(input.level);
      const position =
        input.position === undefined ? current.position : validateTierPosition(input.position);

      await db.scoped(ctx).transaction(async (trx, raw) => {
        await trx
          .updateTable('queue_tiers')
          .set({ level, position })
          .where('id', '=', id)
          .execute();

        await enqueueEvent(raw, pbxEvents, {
          type: 'pbx.queue_tier.updated',
          data: { queueId: current.queueId, agentId: current.agentId },
          orgContext: { tenantId },
          ...(ctx.actorId === undefined || ctx.orgId === undefined
            ? {}
            : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });

      return { ...current, level, position };
    },

    async remove(ctx: DbContext, id: string): Promise<void> {
      const { tenantId } = requireTenant(ctx);
      const existing = await db
        .scoped(ctx)
        .selectFrom('queue_tiers')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing === undefined)
        throw new QueueTierNotFoundError(`No queue tier with id '${id}'.`);
      const current = toQueueTier(existing);

      await db.scoped(ctx).transaction(async (trx, raw) => {
        await trx.deleteFrom('queue_tiers').where('id', '=', id).execute();

        await enqueueEvent(raw, pbxEvents, {
          type: 'pbx.queue_tier.removed',
          data: { queueId: current.queueId, agentId: current.agentId },
          orgContext: { tenantId },
          ...(ctx.actorId === undefined || ctx.orgId === undefined
            ? {}
            : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });
    },
  };
}

export type QueueTierRepo = ReturnType<typeof createQueueTierRepo>;
