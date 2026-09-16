import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { isDuplicateKeyError, requireTenant } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import {
  DidNumberTakenError,
  ExtensionDestinationNotFoundError,
  TrunkNotFoundError,
  validateE164,
  type DestinationType,
} from '../domain/dids.js';
import { pbxEvents } from '../events.js';
import type { TrunkLookup } from '../trunk-client.js';
import type { PbxConfigServiceDb } from '../schema.js';

export interface Did {
  readonly id: string;
  readonly tenantId: string;
  readonly e164: string;
  readonly trunkId: string;
  readonly destinationType: DestinationType;
  readonly destinationId: string;
}

export interface CreateDidInput {
  readonly e164: string;
  readonly trunkId: string;
  readonly destinationType: DestinationType;
  readonly destinationId: string;
}

export interface UpdateDidInput {
  readonly trunkId?: string;
  readonly destinationType?: DestinationType;
  readonly destinationId?: string;
}

export class DidNotFoundError extends Error {
  override readonly name = 'DidNotFoundError';
}

export { DidNumberTakenError, TrunkNotFoundError, ExtensionDestinationNotFoundError };

interface DidRow {
  id: string;
  tenant_id: string;
  e164: string;
  trunk_id: string;
  destination_type: string;
  destination_id: string;
}

function toDid(row: DidRow): Did {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    e164: row.e164,
    trunkId: row.trunk_id,
    destinationType: row.destination_type as DestinationType,
    destinationId: row.destination_id,
  };
}

/**
 * Validates that a DID's `trunk_id`/`destination_id` actually refer to real
 * rows, the same way `extension.repo.ts`'s `create()` validates the tenant
 * has a realm before generating credentials. Only `extension` destinations
 * are checked against a real table (`extensions`, this service's own) —
 * every other destination type has no owning subsystem yet
 * (`domain/dids.ts`'s own comment), so there is nothing to validate against.
 */
async function assertReferencesExist(
  db: Database<PbxConfigServiceDb>,
  ctx: DbContext,
  trunkExists: TrunkLookup,
  tenantId: string,
  trunkId: string,
  destinationType: DestinationType,
  destinationId: string,
): Promise<void> {
  if (!(await trunkExists(tenantId, trunkId))) {
    throw new TrunkNotFoundError(`No trunk with id '${trunkId}' in this tenant.`);
  }
  if (destinationType === 'extension') {
    const extension = await db
      .scoped(ctx)
      .selectFrom('extensions')
      .select('id')
      .where('id', '=', destinationId)
      .executeTakeFirst();
    if (extension === undefined) {
      throw new ExtensionDestinationNotFoundError(
        `No extension with id '${destinationId}' in this tenant.`,
      );
    }
  }
}

/**
 * Data access for DIDs (S2-03; 05 §3.3). Every query goes through
 * `scoped(ctx)` (CLAUDE.md rule 2) — a DID's `e164` is globally unique, but
 * `scoped(ctx)` filtering every read to the caller's own tenant means a DID
 * that actually belongs to a different tenant is simply not found, not
 * distinguished from "does not exist at all". That is exactly the behavior
 * `route{}`'s from-trunk lookup (telephony-config's `/fs/dialplan`, S2-03)
 * needs for "a DID owned by tenant B that arrives on tenant A's trunk is
 * rejected": it looks the dialed number up scoped to the *trunk's* tenant,
 * and a tenant-B-owned DID is invisible there.
 */
export function createDidRepo(db: Database<PbxConfigServiceDb>, trunkExists: TrunkLookup) {
  return {
    list: (ctx: DbContext): Promise<Did[]> =>
      db
        .scoped(ctx)
        .selectFrom('dids')
        .selectAll()
        .orderBy('e164', 'asc')
        .execute()
        .then((rows) => rows.map(toDid)),

    findById: (ctx: DbContext, id: string): Promise<Did | undefined> =>
      db
        .scoped(ctx)
        .selectFrom('dids')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : toDid(row))),

    async create(ctx: DbContext, input: CreateDidInput): Promise<Did> {
      const e164 = validateE164(input.e164);
      const { tenantId } = requireTenant(ctx);

      await assertReferencesExist(
        db,
        ctx,
        trunkExists,
        tenantId,
        input.trunkId,
        input.destinationType,
        input.destinationId,
      );

      const id = randomUUID();
      const now = new Date();

      try {
        await db.scoped(ctx).transaction(async (trx, raw) => {
          await trx
            .insertInto('dids')
            .values({
              id,
              e164,
              trunk_id: input.trunkId,
              destination_type: input.destinationType,
              destination_id: input.destinationId,
              created_at: now,
              updated_at: now,
              version: 1,
            })
            .execute();

          await enqueueEvent(raw, pbxEvents, {
            type: 'pbx.did.created',
            data: { didId: id, e164 },
            orgContext: { tenantId },
            ...(ctx.actorId === undefined || ctx.orgId === undefined
              ? {}
              : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
            ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
          });
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) throw new DidNumberTakenError(e164);
        throw error;
      }

      return {
        id,
        tenantId,
        e164,
        trunkId: input.trunkId,
        destinationType: input.destinationType,
        destinationId: input.destinationId,
      };
    },

    async update(ctx: DbContext, id: string, input: UpdateDidInput): Promise<Did> {
      const { tenantId } = requireTenant(ctx);
      const existing = await db
        .scoped(ctx)
        .selectFrom('dids')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing === undefined) throw new DidNotFoundError(`No DID with id '${id}'.`);

      const trunkId = input.trunkId ?? existing.trunk_id;
      const destinationType = (input.destinationType ??
        existing.destination_type) as DestinationType;
      const destinationId = input.destinationId ?? existing.destination_id;

      await assertReferencesExist(
        db,
        ctx,
        trunkExists,
        tenantId,
        trunkId,
        destinationType,
        destinationId,
      );

      await db.scoped(ctx).transaction(async (trx, raw) => {
        await trx
          .updateTable('dids')
          .set({
            trunk_id: trunkId,
            destination_type: destinationType,
            destination_id: destinationId,
            updated_at: new Date(),
            version: existing.version + 1,
          })
          .where('id', '=', id)
          .execute();

        await enqueueEvent(raw, pbxEvents, {
          type: 'pbx.did.updated',
          data: { didId: id },
          orgContext: { tenantId },
          ...(ctx.actorId === undefined || ctx.orgId === undefined
            ? {}
            : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });

      return toDid({
        ...existing,
        trunk_id: trunkId,
        destination_type: destinationType,
        destination_id: destinationId,
      });
    },

    async remove(ctx: DbContext, id: string): Promise<void> {
      const { tenantId } = requireTenant(ctx);

      await db.scoped(ctx).transaction(async (trx, raw) => {
        const result = await trx.deleteFrom('dids').where('id', '=', id).executeTakeFirst();
        if (Number(result.numDeletedRows) === 0) {
          throw new DidNotFoundError(`No DID with id '${id}'.`);
        }

        await enqueueEvent(raw, pbxEvents, {
          type: 'pbx.did.deleted',
          data: { didId: id },
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

export type DidRepo = ReturnType<typeof createDidRepo>;
