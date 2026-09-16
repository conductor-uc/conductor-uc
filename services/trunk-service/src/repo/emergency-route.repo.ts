import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { requireTenant } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import { validateNumbers } from '../domain/emergency-route.js';
import { trunkEvents } from '../events.js';
import type { TrunkServiceDb } from '../schema.js';

export interface EmergencyRoute {
  readonly id: string;
  readonly tenantId: string;
  readonly trunkId: string;
  readonly numbers: readonly string[];
}

export interface UpsertEmergencyRouteInput {
  readonly trunkId: string;
  readonly numbers: readonly string[];
}

export class EmergencyRouteNotFoundError extends Error {
  override readonly name = 'EmergencyRouteNotFoundError';
}

interface EmergencyRouteRow {
  id: string;
  tenant_id: string;
  trunk_id: string;
  numbers: unknown;
  version: number;
}

/** `emergency_routes.numbers` is declared `json` — same driver-parsing quirk `outbound-route.repo.ts`'s `parseTrunkIds` documents. */
function parseNumbers(value: unknown): string[] {
  return typeof value === 'string' ? (JSON.parse(value) as string[]) : (value as string[]);
}

function toEmergencyRoute(row: EmergencyRouteRow): EmergencyRoute {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    trunkId: row.trunk_id,
    numbers: parseNumbers(row.numbers),
  };
}

const COLUMNS = ['id', 'tenant_id', 'trunk_id', 'numbers', 'version'] as const;

/**
 * Data access for a tenant's own emergency route (S2-06; 05 §3.4, G-1).
 * Every query goes through `scoped(ctx)` (CLAUDE.md rule 2). One row per
 * tenant (`emergency_routes_tenant_idx` unique) — `upsert` is the only
 * write, no separate create/update the way `outbound_routes` has, since
 * there's nothing to disambiguate ("which one?") for a singleton. No
 * referential check against `trunkId` — same documented gap
 * `outbound-route.repo.ts`'s own comment already accepts for `trunk_ids`.
 */
export function createEmergencyRouteRepo(db: Database<TrunkServiceDb>) {
  return {
    find: (ctx: DbContext): Promise<EmergencyRoute | undefined> =>
      db
        .scoped(ctx)
        .selectFrom('emergency_routes')
        .select(COLUMNS)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : toEmergencyRoute(row))),

    /**
     * Every emergency route, across every tenant — what telephony-config's
     * `GET /internal/v1/emergency-routes` (S2-06) serves, the same
     * "list everything for projection" shape `outbound-route.repo.ts`'s own
     * `listAll` already established.
     */
    async listAll(): Promise<EmergencyRoute[]> {
      const rows = await db.kysely.selectFrom('emergency_routes').select(COLUMNS).execute();
      return rows.map(toEmergencyRoute);
    },

    async upsert(ctx: DbContext, input: UpsertEmergencyRouteInput): Promise<EmergencyRoute> {
      const { tenantId } = requireTenant(ctx);
      const numbers = validateNumbers(input.numbers);
      const now = new Date();

      const existing = await db
        .scoped(ctx)
        .selectFrom('emergency_routes')
        .select(COLUMNS)
        .executeTakeFirst();

      const id = existing?.id ?? randomUUID();
      const eventType =
        existing === undefined ? 'trunk.emergency_route.created' : 'trunk.emergency_route.updated';

      await db.scoped(ctx).transaction(async (trx, raw) => {
        if (existing === undefined) {
          await trx
            .insertInto('emergency_routes')
            .values({
              id,
              trunk_id: input.trunkId,
              numbers: JSON.stringify(numbers),
              created_at: now,
              updated_at: now,
              version: 1,
            })
            .execute();
        } else {
          await trx
            .updateTable('emergency_routes')
            .set({
              trunk_id: input.trunkId,
              numbers: JSON.stringify(numbers),
              updated_at: now,
              version: existing.version + 1,
            })
            .where('id', '=', id)
            .execute();
        }

        await enqueueEvent(raw, trunkEvents, {
          type: eventType,
          data: { emergencyRouteId: id },
          orgContext: { tenantId },
          ...(ctx.actorId === undefined || ctx.orgId === undefined
            ? {}
            : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });

      return { id, tenantId, trunkId: input.trunkId, numbers };
    },

    async remove(ctx: DbContext): Promise<void> {
      const { tenantId } = requireTenant(ctx);

      await db.scoped(ctx).transaction(async (trx, raw) => {
        const existing = await trx
          .selectFrom('emergency_routes')
          .select('id')
          .where('tenant_id', '=', tenantId)
          .executeTakeFirst();
        if (existing === undefined) {
          throw new EmergencyRouteNotFoundError(`No emergency route for tenant '${tenantId}'.`);
        }

        await trx.deleteFrom('emergency_routes').where('id', '=', existing.id).execute();

        await enqueueEvent(raw, trunkEvents, {
          type: 'trunk.emergency_route.deleted',
          data: { emergencyRouteId: existing.id },
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

export type EmergencyRouteRepo = ReturnType<typeof createEmergencyRouteRepo>;
