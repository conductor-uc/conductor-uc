import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { isDuplicateKeyError, requireTenant } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import {
  validateMaxNoAnswer,
  validateRejectDelaySeconds,
  validateWrapUpSeconds,
} from '../domain/agent.js';
import { pbxEvents } from '../events.js';
import type { PbxConfigServiceDb } from '../schema.js';

export interface Agent {
  readonly id: string;
  readonly tenantId: string;
  readonly extensionId: string;
  readonly maxNoAnswer: number;
  readonly wrapUpSeconds: number;
  readonly rejectDelaySeconds: number;
}

export interface CreateAgentInput {
  readonly extensionId: string;
  readonly maxNoAnswer?: number;
  readonly wrapUpSeconds?: number;
  readonly rejectDelaySeconds?: number;
}

export interface UpdateAgentInput {
  readonly maxNoAnswer?: number;
  readonly wrapUpSeconds?: number;
  readonly rejectDelaySeconds?: number;
}

const DEFAULT_MAX_NO_ANSWER = 3;
const DEFAULT_WRAP_UP_SECONDS = 0;
const DEFAULT_REJECT_DELAY_SECONDS = 0;

export class AgentNotFoundError extends Error {
  override readonly name = 'AgentNotFoundError';
}

export class AgentExtensionNotFoundError extends Error {
  override readonly name = 'AgentExtensionNotFoundError';
}

/** The extension already has an agent identity — `extension_id` is unique per tenant (`006_add_queues.ts`). */
export class ExtensionAlreadyAgentError extends Error {
  override readonly name = 'ExtensionAlreadyAgentError';
}

interface AgentRow {
  id: string;
  tenant_id: string;
  extension_id: string;
  max_no_answer: number;
  wrap_up_seconds: number;
  reject_delay_seconds: number;
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    extensionId: row.extension_id,
    maxNoAnswer: row.max_no_answer,
    wrapUpSeconds: row.wrap_up_seconds,
    rejectDelaySeconds: row.reject_delay_seconds,
  };
}

async function assertExtensionExists(
  db: Database<PbxConfigServiceDb>,
  ctx: DbContext,
  extensionId: string,
): Promise<void> {
  const found = await db
    .scoped(ctx)
    .selectFrom('extensions')
    .select('id')
    .where('id', '=', extensionId)
    .executeTakeFirst();
  if (found === undefined) {
    throw new AgentExtensionNotFoundError(`No extension with id '${extensionId}' in this tenant.`);
  }
}

/**
 * Data access for agents (S2-13; 05 §3.3). Every query goes through
 * `scoped(ctx)` (CLAUDE.md rule 2). Publishes `pbx.agent.*` the same thin,
 * "re-fetch current state" way `pbx.queue.*` does.
 */
export function createAgentRepo(db: Database<PbxConfigServiceDb>) {
  return {
    list: (ctx: DbContext): Promise<Agent[]> =>
      db
        .scoped(ctx)
        .selectFrom('agents')
        .selectAll()
        .orderBy('created_at', 'asc')
        .execute()
        .then((rows) => rows.map(toAgent)),

    findById: (ctx: DbContext, id: string): Promise<Agent | undefined> =>
      db
        .scoped(ctx)
        .selectFrom('agents')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : toAgent(row))),

    findByExtensionId: (ctx: DbContext, extensionId: string): Promise<Agent | undefined> =>
      db
        .scoped(ctx)
        .selectFrom('agents')
        .selectAll()
        .where('extension_id', '=', extensionId)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : toAgent(row))),

    async create(ctx: DbContext, input: CreateAgentInput): Promise<Agent> {
      const { tenantId } = requireTenant(ctx);
      const maxNoAnswer = validateMaxNoAnswer(input.maxNoAnswer ?? DEFAULT_MAX_NO_ANSWER);
      const wrapUpSeconds = validateWrapUpSeconds(input.wrapUpSeconds ?? DEFAULT_WRAP_UP_SECONDS);
      const rejectDelaySeconds = validateRejectDelaySeconds(
        input.rejectDelaySeconds ?? DEFAULT_REJECT_DELAY_SECONDS,
      );
      await assertExtensionExists(db, ctx, input.extensionId);

      const id = randomUUID();
      const now = new Date();

      try {
        await db.scoped(ctx).transaction(async (trx, raw) => {
          await trx
            .insertInto('agents')
            .values({
              id,
              extension_id: input.extensionId,
              max_no_answer: maxNoAnswer,
              wrap_up_seconds: wrapUpSeconds,
              reject_delay_seconds: rejectDelaySeconds,
              created_at: now,
              updated_at: now,
              version: 1,
            })
            .execute();

          await enqueueEvent(raw, pbxEvents, {
            type: 'pbx.agent.created',
            data: { agentId: id },
            orgContext: { tenantId },
            ...(ctx.actorId === undefined || ctx.orgId === undefined
              ? {}
              : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
            ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
          });
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new ExtensionAlreadyAgentError(
            `Extension '${input.extensionId}' is already an agent.`,
          );
        }
        throw error;
      }

      return {
        id,
        tenantId,
        extensionId: input.extensionId,
        maxNoAnswer,
        wrapUpSeconds,
        rejectDelaySeconds,
      };
    },

    async update(ctx: DbContext, id: string, input: UpdateAgentInput): Promise<Agent> {
      const { tenantId } = requireTenant(ctx);
      const existing = await db
        .scoped(ctx)
        .selectFrom('agents')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing === undefined) throw new AgentNotFoundError(`No agent with id '${id}'.`);
      const current = toAgent(existing);

      const maxNoAnswer =
        input.maxNoAnswer === undefined
          ? current.maxNoAnswer
          : validateMaxNoAnswer(input.maxNoAnswer);
      const wrapUpSeconds =
        input.wrapUpSeconds === undefined
          ? current.wrapUpSeconds
          : validateWrapUpSeconds(input.wrapUpSeconds);
      const rejectDelaySeconds =
        input.rejectDelaySeconds === undefined
          ? current.rejectDelaySeconds
          : validateRejectDelaySeconds(input.rejectDelaySeconds);

      await db.scoped(ctx).transaction(async (trx, raw) => {
        await trx
          .updateTable('agents')
          .set({
            max_no_answer: maxNoAnswer,
            wrap_up_seconds: wrapUpSeconds,
            reject_delay_seconds: rejectDelaySeconds,
            updated_at: new Date(),
            version: existing.version + 1,
          })
          .where('id', '=', id)
          .execute();

        await enqueueEvent(raw, pbxEvents, {
          type: 'pbx.agent.updated',
          data: { agentId: id },
          orgContext: { tenantId },
          ...(ctx.actorId === undefined || ctx.orgId === undefined
            ? {}
            : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });

      return { ...current, maxNoAnswer, wrapUpSeconds, rejectDelaySeconds };
    },

    async remove(ctx: DbContext, id: string): Promise<void> {
      const { tenantId } = requireTenant(ctx);

      await db.scoped(ctx).transaction(async (trx, raw) => {
        // No owning FK for `queue_tiers.agent_id` in this schema (05 §1.1) — clean up tier rows explicitly, same as `queue.repo.ts`'s own `remove`.
        await trx.deleteFrom('queue_tiers').where('agent_id', '=', id).execute();

        const result = await trx.deleteFrom('agents').where('id', '=', id).executeTakeFirst();
        if (Number(result.numDeletedRows) === 0) {
          throw new AgentNotFoundError(`No agent with id '${id}'.`);
        }

        await enqueueEvent(raw, pbxEvents, {
          type: 'pbx.agent.deleted',
          data: { agentId: id },
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

export type AgentRepo = ReturnType<typeof createAgentRepo>;
