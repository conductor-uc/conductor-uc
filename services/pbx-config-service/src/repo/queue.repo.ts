import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { requireTenant } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import type { DestinationType } from '../domain/dids.js';
import {
  validateAnnouncePosition,
  validateLabel,
  validateMaxWaitSeconds,
  validateNoAgentDestination,
  validateStrategy,
  type QueueStrategy,
} from '../domain/queue.js';
import { pbxEvents } from '../events.js';
import type { PbxConfigServiceDb } from '../schema.js';

export interface Queue {
  readonly id: string;
  readonly tenantId: string;
  readonly label: string;
  readonly strategy: QueueStrategy;
  readonly mohMediaAssetId: string | null;
  readonly maxWaitSeconds: number;
  readonly announcePosition: boolean;
  readonly announceFrequencySeconds: number | null;
  readonly noAgentDestinationType: DestinationType | null;
  readonly noAgentDestinationId: string | null;
}

export interface CreateQueueInput {
  readonly label: string;
  readonly strategy: string;
  readonly mohMediaAssetId?: string | null;
  readonly maxWaitSeconds: number;
  readonly announcePosition: boolean;
  readonly announceFrequencySeconds?: number | null;
  readonly noAgentDestinationType?: string | null;
  readonly noAgentDestinationId?: string | null;
}

export type UpdateQueueInput = Partial<CreateQueueInput>;

export class QueueNotFoundError extends Error {
  override readonly name = 'QueueNotFoundError';
}

interface QueueRow {
  id: string;
  tenant_id: string;
  label: string;
  strategy: string;
  moh_media_asset_id: string | null;
  max_wait_seconds: number;
  announce_position: boolean | number;
  announce_frequency_seconds: number | null;
  no_agent_destination_type: string | null;
  no_agent_destination_id: string | null;
}

function toQueue(row: QueueRow): Queue {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    label: row.label,
    strategy: row.strategy as QueueStrategy,
    mohMediaAssetId: row.moh_media_asset_id,
    maxWaitSeconds: row.max_wait_seconds,
    // MariaDB's `boolean` is `tinyint(1)`; some drivers hand back `0`/`1` rather than a real boolean.
    announcePosition: row.announce_position === true || row.announce_position === 1,
    announceFrequencySeconds: row.announce_frequency_seconds,
    noAgentDestinationType: row.no_agent_destination_type as DestinationType | null,
    noAgentDestinationId: row.no_agent_destination_id,
  };
}

/**
 * Data access for queues (S2-13; 05 §3.3). Every query goes through
 * `scoped(ctx)` (CLAUDE.md rule 2). Publishes `pbx.queue.*` the same thin,
 * "re-fetch current state" way `pbx.ring_group.*` does — telephony-config
 * keeps a local projected mirror, since `callcenter.conf` is served from a
 * hot xml_curl path, the same reasoning `ring-group.repo.ts`'s own doc
 * comment gives.
 */
export function createQueueRepo(db: Database<PbxConfigServiceDb>) {
  return {
    list: (ctx: DbContext): Promise<Queue[]> =>
      db
        .scoped(ctx)
        .selectFrom('queues')
        .selectAll()
        .orderBy('label', 'asc')
        .execute()
        .then((rows) => rows.map(toQueue)),

    findById: (ctx: DbContext, id: string): Promise<Queue | undefined> =>
      db
        .scoped(ctx)
        .selectFrom('queues')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : toQueue(row))),

    async create(ctx: DbContext, input: CreateQueueInput): Promise<Queue> {
      const { tenantId } = requireTenant(ctx);
      const label = validateLabel(input.label);
      const strategy = validateStrategy(input.strategy);
      const maxWaitSeconds = validateMaxWaitSeconds(input.maxWaitSeconds);
      const announceFrequencySeconds = validateAnnouncePosition(
        input.announcePosition,
        input.announceFrequencySeconds,
      );
      const noAgentDestination = validateNoAgentDestination(
        input.noAgentDestinationType,
        input.noAgentDestinationId,
      );

      const id = randomUUID();
      const now = new Date();

      await db.scoped(ctx).transaction(async (trx, raw) => {
        await trx
          .insertInto('queues')
          .values({
            id,
            label,
            strategy,
            moh_media_asset_id: input.mohMediaAssetId ?? null,
            max_wait_seconds: maxWaitSeconds,
            announce_position: input.announcePosition,
            announce_frequency_seconds: announceFrequencySeconds,
            no_agent_destination_type: noAgentDestination?.type ?? null,
            no_agent_destination_id: noAgentDestination?.id ?? null,
            created_at: now,
            updated_at: now,
            version: 1,
          })
          .execute();

        await enqueueEvent(raw, pbxEvents, {
          type: 'pbx.queue.created',
          data: { queueId: id },
          orgContext: { tenantId },
          ...(ctx.actorId === undefined || ctx.orgId === undefined
            ? {}
            : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });

      return {
        id,
        tenantId,
        label,
        strategy,
        mohMediaAssetId: input.mohMediaAssetId ?? null,
        maxWaitSeconds,
        announcePosition: input.announcePosition,
        announceFrequencySeconds,
        noAgentDestinationType: noAgentDestination?.type ?? null,
        noAgentDestinationId: noAgentDestination?.id ?? null,
      };
    },

    async update(ctx: DbContext, id: string, input: UpdateQueueInput): Promise<Queue> {
      const { tenantId } = requireTenant(ctx);
      const existing = await db
        .scoped(ctx)
        .selectFrom('queues')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing === undefined) throw new QueueNotFoundError(`No queue with id '${id}'.`);
      const current = toQueue(existing);

      const label = input.label === undefined ? current.label : validateLabel(input.label);
      const strategy =
        input.strategy === undefined ? current.strategy : validateStrategy(input.strategy);
      const maxWaitSeconds =
        input.maxWaitSeconds === undefined
          ? current.maxWaitSeconds
          : validateMaxWaitSeconds(input.maxWaitSeconds);
      const announcePosition = input.announcePosition ?? current.announcePosition;
      const announceFrequencySeconds = validateAnnouncePosition(
        announcePosition,
        input.announceFrequencySeconds === undefined
          ? current.announceFrequencySeconds
          : input.announceFrequencySeconds,
      );
      const mohMediaAssetId =
        input.mohMediaAssetId === undefined ? current.mohMediaAssetId : input.mohMediaAssetId;
      const noAgentDestination =
        input.noAgentDestinationType === undefined && input.noAgentDestinationId === undefined
          ? current.noAgentDestinationType === null
            ? null
            : { type: current.noAgentDestinationType, id: current.noAgentDestinationId as string }
          : validateNoAgentDestination(input.noAgentDestinationType, input.noAgentDestinationId);

      await db.scoped(ctx).transaction(async (trx, raw) => {
        await trx
          .updateTable('queues')
          .set({
            label,
            strategy,
            moh_media_asset_id: mohMediaAssetId,
            max_wait_seconds: maxWaitSeconds,
            announce_position: announcePosition,
            announce_frequency_seconds: announceFrequencySeconds,
            no_agent_destination_type: noAgentDestination?.type ?? null,
            no_agent_destination_id: noAgentDestination?.id ?? null,
            updated_at: new Date(),
            version: existing.version + 1,
          })
          .where('id', '=', id)
          .execute();

        await enqueueEvent(raw, pbxEvents, {
          type: 'pbx.queue.updated',
          data: { queueId: id },
          orgContext: { tenantId },
          ...(ctx.actorId === undefined || ctx.orgId === undefined
            ? {}
            : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });

      return {
        id,
        tenantId,
        label,
        strategy,
        mohMediaAssetId,
        maxWaitSeconds,
        announcePosition,
        announceFrequencySeconds,
        noAgentDestinationType: noAgentDestination?.type ?? null,
        noAgentDestinationId: noAgentDestination?.id ?? null,
      };
    },

    async remove(ctx: DbContext, id: string): Promise<void> {
      const { tenantId } = requireTenant(ctx);

      await db.scoped(ctx).transaction(async (trx, raw) => {
        // `queue_tiers` rows referencing this queue are cleaned up here
        // rather than left orphaned — no FK in this schema (05 §1.1: one
        // schema, tenant isolation via `scoped(ctx)`, not DB-level FKs
        // across what are logically separate resource tables).
        await trx.deleteFrom('queue_tiers').where('queue_id', '=', id).execute();

        const result = await trx.deleteFrom('queues').where('id', '=', id).executeTakeFirst();
        if (Number(result.numDeletedRows) === 0) {
          throw new QueueNotFoundError(`No queue with id '${id}'.`);
        }

        await enqueueEvent(raw, pbxEvents, {
          type: 'pbx.queue.deleted',
          data: { queueId: id },
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

export type QueueRepo = ReturnType<typeof createQueueRepo>;
