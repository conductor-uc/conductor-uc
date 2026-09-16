import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { requireTenant } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import {
  validatePattern,
  validatePrepend,
  validatePriority,
  validateStrip,
  validateTrunkIds,
} from '../domain/outbound-route.js';
import { trunkEvents } from '../events.js';
import type { TrunkServiceDb } from '../schema.js';

export interface OutboundRoute {
  readonly id: string;
  readonly tenantId: string;
  readonly priority: number;
  readonly pattern: string;
  readonly trunkIds: readonly string[];
  readonly strip: number;
  readonly prepend: string | null;
}

export interface CreateOutboundRouteInput {
  readonly priority: number;
  readonly pattern: string;
  readonly trunkIds: readonly string[];
  readonly strip?: number;
  readonly prepend?: string | null;
}

export interface UpdateOutboundRouteInput {
  readonly priority?: number;
  readonly pattern?: string;
  readonly trunkIds?: readonly string[];
  readonly strip?: number;
  readonly prepend?: string | null;
}

export class OutboundRouteNotFoundError extends Error {
  override readonly name = 'OutboundRouteNotFoundError';
}

interface OutboundRouteRow {
  id: string;
  tenant_id: string;
  priority: number;
  pattern: string;
  trunk_ids: unknown;
  strip: number;
  prepend: string | null;
}

/**
 * `outbound_routes.trunk_ids` is declared `json` in the migration — same
 * driver-parsing quirk `trunk.repo.ts`'s `parseJsonCodecs` documents.
 */
function parseTrunkIds(value: unknown): string[] {
  return typeof value === 'string' ? (JSON.parse(value) as string[]) : (value as string[]);
}

function toOutboundRoute(row: OutboundRouteRow): OutboundRoute {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    priority: row.priority,
    pattern: row.pattern,
    trunkIds: parseTrunkIds(row.trunk_ids),
    strip: row.strip,
    prepend: row.prepend,
  };
}

const OUTBOUND_ROUTE_COLUMNS = [
  'id',
  'tenant_id',
  'priority',
  'pattern',
  'trunk_ids',
  'strip',
  'prepend',
  'version',
] as const;

/**
 * Data access for outbound routes (S2-04; 05 §3.4). Every query goes
 * through `scoped(ctx)` (CLAUDE.md rule 2). No referential check against
 * `trunk_ids` here — an outbound route naming a trunk that is later deleted
 * is a real gap this task does not close (docs/decisions.md), matching the
 * same "nothing enforces this yet" pattern DIDs' non-extension destination
 * types already accept (S2-03's G-25).
 */
export function createOutboundRouteRepo(db: Database<TrunkServiceDb>) {
  return {
    list: (ctx: DbContext): Promise<OutboundRoute[]> =>
      db
        .scoped(ctx)
        .selectFrom('outbound_routes')
        .select(OUTBOUND_ROUTE_COLUMNS)
        .orderBy('priority', 'asc')
        .execute()
        .then((rows) => rows.map(toOutboundRoute)),

    findById: (ctx: DbContext, id: string): Promise<OutboundRoute | undefined> =>
      db
        .scoped(ctx)
        .selectFrom('outbound_routes')
        .select(OUTBOUND_ROUTE_COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : toOutboundRoute(row))),

    /**
     * Every outbound route, across every tenant — what telephony-config's
     * `GET /internal/v1/outbound-routes` (S2-04) serves, the same "list
     * everything" shape `trunk.repo.ts`'s `listAllForProjection` already
     * established for this service (G-16/G-17). Unscoped by necessity: no
     * per-request tenant actor to scope to, and no user-facing route ever
     * calls this.
     */
    async listAll(): Promise<OutboundRoute[]> {
      const rows = await db.kysely
        .selectFrom('outbound_routes')
        .select(OUTBOUND_ROUTE_COLUMNS)
        .execute();
      return rows.map(toOutboundRoute);
    },

    async create(ctx: DbContext, input: CreateOutboundRouteInput): Promise<OutboundRoute> {
      const { tenantId } = requireTenant(ctx);
      const priority = validatePriority(input.priority);
      const pattern = validatePattern(input.pattern);
      const trunkIds = validateTrunkIds(input.trunkIds);
      const strip = validateStrip(input.strip ?? 0);
      const prepend = validatePrepend(input.prepend);

      const id = randomUUID();
      const now = new Date();

      await db.scoped(ctx).transaction(async (trx, raw) => {
        await trx
          .insertInto('outbound_routes')
          .values({
            id,
            priority,
            pattern,
            trunk_ids: JSON.stringify(trunkIds),
            strip,
            prepend,
            created_at: now,
            updated_at: now,
            version: 1,
          })
          .execute();

        await enqueueEvent(raw, trunkEvents, {
          type: 'trunk.outbound_route.created',
          data: { outboundRouteId: id },
          orgContext: { tenantId },
          ...(ctx.actorId === undefined || ctx.orgId === undefined
            ? {}
            : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });

      return { id, tenantId, priority, pattern, trunkIds, strip, prepend };
    },

    async update(
      ctx: DbContext,
      id: string,
      input: UpdateOutboundRouteInput,
    ): Promise<OutboundRoute> {
      const { tenantId } = requireTenant(ctx);
      const existing = await db
        .scoped(ctx)
        .selectFrom('outbound_routes')
        .select(OUTBOUND_ROUTE_COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing === undefined) {
        throw new OutboundRouteNotFoundError(`No outbound route with id '${id}'.`);
      }

      const merged = {
        priority:
          input.priority === undefined ? existing.priority : validatePriority(input.priority),
        pattern: input.pattern === undefined ? existing.pattern : validatePattern(input.pattern),
        trunkIds:
          input.trunkIds === undefined
            ? parseTrunkIds(existing.trunk_ids)
            : validateTrunkIds(input.trunkIds),
        strip: input.strip === undefined ? existing.strip : validateStrip(input.strip),
        prepend: input.prepend === undefined ? existing.prepend : validatePrepend(input.prepend),
      };

      await db.scoped(ctx).transaction(async (trx, raw) => {
        await trx
          .updateTable('outbound_routes')
          .set({
            priority: merged.priority,
            pattern: merged.pattern,
            trunk_ids: JSON.stringify(merged.trunkIds),
            strip: merged.strip,
            prepend: merged.prepend,
            updated_at: new Date(),
            version: existing.version + 1,
          })
          .where('id', '=', id)
          .execute();

        await enqueueEvent(raw, trunkEvents, {
          type: 'trunk.outbound_route.updated',
          data: { outboundRouteId: id },
          orgContext: { tenantId },
          ...(ctx.actorId === undefined || ctx.orgId === undefined
            ? {}
            : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });

      return { id, tenantId, ...merged };
    },

    async remove(ctx: DbContext, id: string): Promise<void> {
      const { tenantId } = requireTenant(ctx);

      await db.scoped(ctx).transaction(async (trx, raw) => {
        const result = await trx
          .deleteFrom('outbound_routes')
          .where('id', '=', id)
          .executeTakeFirst();
        if (Number(result.numDeletedRows) === 0) {
          throw new OutboundRouteNotFoundError(`No outbound route with id '${id}'.`);
        }

        await enqueueEvent(raw, trunkEvents, {
          type: 'trunk.outbound_route.deleted',
          data: { outboundRouteId: id },
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

export type OutboundRouteRepo = ReturnType<typeof createOutboundRouteRepo>;
