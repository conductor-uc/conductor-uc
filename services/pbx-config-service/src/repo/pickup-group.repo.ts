import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { requireTenant } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import { validatePickupLabel, validatePickupMembers } from '../domain/pickup-group.js';
import { pbxEvents } from '../events.js';
import type { PbxConfigServiceDb } from '../schema.js';

export interface PickupGroup {
  readonly id: string;
  readonly tenantId: string;
  readonly label: string;
  readonly memberExtensionIds: readonly string[];
}

export interface PickupGroupInput {
  readonly label: string;
  readonly memberExtensionIds: readonly string[];
}

export class PickupGroupNotFoundError extends Error {
  override readonly name = 'PickupGroupNotFoundError';
}

export class PickupGroupMemberNotFoundError extends Error {
  override readonly name = 'PickupGroupMemberNotFoundError';

  constructor(
    message: string,
    readonly params: { readonly extensionIds: readonly string[] },
  ) {
    super(message);
  }
}

interface Row {
  id: string;
  tenant_id: string;
  label: string;
  member_extension_ids: unknown;
}

function toPickupGroup(row: Row): PickupGroup {
  const members = row.member_extension_ids;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    label: row.label,
    memberExtensionIds:
      typeof members === 'string' ? (JSON.parse(members) as string[]) : (members as string[]),
  };
}

/**
 * S9-18 (G-125): pickup groups. Every change is announced on the outbox
 * (`pbx.pickup_group.*`), though nothing projects them: call-control asks
 * (`/internal/.../pickup-peers`) when someone picks up.
 */
export function createPickupGroupRepo(db: Database<PbxConfigServiceDb>) {
  async function assertExtensionsExist(ctx: DbContext, ids: readonly string[]): Promise<void> {
    const found = await db
      .scoped(ctx)
      .selectFrom('extensions')
      .select('id')
      .where('id', 'in', [...ids])
      .execute();
    const known = new Set(found.map((row) => row.id));
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new PickupGroupMemberNotFoundError(
        `No extension(s) with id(s) ${missing.join(', ')} in this tenant.`,
        { extensionIds: missing },
      );
    }
  }

  /** The outbox event for a change to pickup group [pickupGroupId]. */
  function event(
    ctx: DbContext,
    type: 'pbx.pickup_group.created' | 'pbx.pickup_group.updated' | 'pbx.pickup_group.deleted',
    pickupGroupId: string,
  ) {
    const { tenantId } = requireTenant(ctx);
    return {
      type,
      data: { pickupGroupId },
      orgContext: { tenantId },
      ...(ctx.actorId === undefined || ctx.orgId === undefined
        ? {}
        : { actor: { type: 'user' as const, id: ctx.actorId, orgId: ctx.orgId } }),
      ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
    };
  }

  async function find(ctx: DbContext, id: string): Promise<PickupGroup | undefined> {
    const row = await db
      .scoped(ctx)
      .selectFrom('pickup_groups')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toPickupGroup(row);
  }

  return {
    list: async (ctx: DbContext): Promise<PickupGroup[]> =>
      (await db.scoped(ctx).selectFrom('pickup_groups').selectAll().orderBy('label').execute()).map(
        toPickupGroup,
      ),

    findById: find,

    async create(ctx: DbContext, input: PickupGroupInput): Promise<PickupGroup> {
      const { tenantId } = requireTenant(ctx);
      const label = validatePickupLabel(input.label);
      const members = validatePickupMembers(input.memberExtensionIds);
      await assertExtensionsExist(ctx, members);
      const id = randomUUID();
      const now = new Date();
      await db.scoped(ctx).transaction(async (trx, raw) => {
        await trx
          .insertInto('pickup_groups')
          .values({
            id,
            label,
            member_extension_ids: JSON.stringify(members),
            created_at: now,
            updated_at: now,
            version: 1,
          })
          .execute();
        await enqueueEvent(raw, pbxEvents, event(ctx, 'pbx.pickup_group.created', id));
      });
      return { id, tenantId, label, memberExtensionIds: members };
    },

    async update(
      ctx: DbContext,
      id: string,
      input: Partial<PickupGroupInput>,
    ): Promise<PickupGroup> {
      const current = await find(ctx, id);
      if (current === undefined) {
        throw new PickupGroupNotFoundError(`No pickup group with id '${id}'.`);
      }
      const label = input.label === undefined ? current.label : validatePickupLabel(input.label);
      const members =
        input.memberExtensionIds === undefined
          ? [...current.memberExtensionIds]
          : validatePickupMembers(input.memberExtensionIds);
      if (input.memberExtensionIds !== undefined) await assertExtensionsExist(ctx, members);
      await db.scoped(ctx).transaction(async (trx, raw) => {
        await trx
          .updateTable('pickup_groups')
          .set((eb) => ({
            label,
            member_extension_ids: JSON.stringify(members),
            updated_at: new Date(),
            version: eb('version', '+', 1),
          }))
          .where('id', '=', id)
          .execute();
        await enqueueEvent(raw, pbxEvents, event(ctx, 'pbx.pickup_group.updated', id));
      });
      return { ...current, label, memberExtensionIds: members };
    },

    async remove(ctx: DbContext, id: string): Promise<void> {
      if ((await find(ctx, id)) === undefined) {
        throw new PickupGroupNotFoundError(`No pickup group with id '${id}'.`);
      }
      await db.scoped(ctx).transaction(async (trx, raw) => {
        await trx.deleteFrom('pickup_groups').where('id', '=', id).execute();
        await enqueueEvent(raw, pbxEvents, event(ctx, 'pbx.pickup_group.deleted', id));
      });
    },
  };
}

export type PickupGroupRepo = ReturnType<typeof createPickupGroupRepo>;
