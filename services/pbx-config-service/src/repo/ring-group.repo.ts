import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { requireTenant } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import type { DestinationType } from '../domain/dids.js';
import {
  validateLabel,
  validateMemberExtensionIds,
  validateNoAnswerDestination,
  validateRingTimeoutSeconds,
  validateStrategy,
  type RingStrategy,
} from '../domain/ring-group.js';
import { pbxEvents } from '../events.js';
import type { PbxConfigServiceDb } from '../schema.js';

export interface RingGroup {
  readonly id: string;
  readonly tenantId: string;
  readonly label: string;
  readonly strategy: RingStrategy;
  readonly memberExtensionIds: readonly string[];
  readonly ringTimeoutSeconds: number;
  readonly noAnswerDestinationType: DestinationType | null;
  readonly noAnswerDestinationId: string | null;
}

export interface CreateRingGroupInput {
  readonly label: string;
  readonly strategy: string;
  readonly memberExtensionIds: readonly string[];
  readonly ringTimeoutSeconds: number;
  readonly noAnswerDestinationType?: string | null;
  readonly noAnswerDestinationId?: string | null;
}

export type UpdateRingGroupInput = Partial<CreateRingGroupInput>;

export class RingGroupNotFoundError extends Error {
  override readonly name = 'RingGroupNotFoundError';
}

/** A `member_extension_ids` (or `no_answer_destination_id`, when the type is `extension`) entry that does not name a real extension in this tenant. */
export class RingGroupMemberNotFoundError extends Error {
  override readonly name = 'RingGroupMemberNotFoundError';
}

interface RingGroupRow {
  id: string;
  tenant_id: string;
  label: string;
  strategy: string;
  member_extension_ids: unknown;
  ring_timeout_seconds: number;
  no_answer_destination_type: string | null;
  no_answer_destination_id: string | null;
}

/** `member_extension_ids` is declared `json` in the migration — same driver quirk `trunk-service`'s own `outbound_routes.trunk_ids` handles (`repo/outbound-route.repo.ts`'s `parseTrunkIds`): some drivers hand back the column already parsed, others hand back the raw text. */
function parseMemberIds(value: unknown): string[] {
  return typeof value === 'string' ? (JSON.parse(value) as string[]) : (value as string[]);
}

function toRingGroup(row: RingGroupRow): RingGroup {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    label: row.label,
    strategy: row.strategy as RingStrategy,
    memberExtensionIds: parseMemberIds(row.member_extension_ids),
    ringTimeoutSeconds: row.ring_timeout_seconds,
    noAnswerDestinationType: row.no_answer_destination_type as DestinationType | null,
    noAnswerDestinationId: row.no_answer_destination_id,
  };
}

/**
 * Checks that every extension id a ring group references (members, plus an
 * `extension`-typed no-answer destination) is real, in this tenant — the
 * same "an id in whatever table `destination_type` names" check `did.repo.
 * ts`'s `assertReferencesExist` already does for a DID's own `extension`
 * destination.
 */
async function assertExtensionsExist(
  db: Database<PbxConfigServiceDb>,
  ctx: DbContext,
  extensionIds: readonly string[],
): Promise<void> {
  if (extensionIds.length === 0) return;
  const found = await db
    .scoped(ctx)
    .selectFrom('extensions')
    .select('id')
    .where('id', 'in', [...extensionIds])
    .execute();
  const foundIds = new Set(found.map((row) => row.id));
  const missing = extensionIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new RingGroupMemberNotFoundError(
      `No extension(s) with id(s) ${missing.join(', ')} in this tenant.`,
    );
  }
}

/**
 * Data access for ring/hunt groups (S2-08; 05 §3.3). Every query goes
 * through `scoped(ctx)` (CLAUDE.md rule 2). Publishes `pbx.ring_group.*` the
 * same "thin event, re-fetch current state" way `pbx.did.*` does — this is a
 * call-setup-hot-path resource (a DID can point straight at one), so
 * telephony-config keeps a local projected mirror rather than calling back
 * on every inbound call, unlike `emergency-location.repo.ts`'s deliberate
 * no-event, live-fetch choice for a resource only touched on the rare
 * emergency path.
 */
export function createRingGroupRepo(db: Database<PbxConfigServiceDb>) {
  return {
    list: (ctx: DbContext): Promise<RingGroup[]> =>
      db
        .scoped(ctx)
        .selectFrom('ring_groups')
        .selectAll()
        .orderBy('label', 'asc')
        .execute()
        .then((rows) => rows.map(toRingGroup)),

    findById: (ctx: DbContext, id: string): Promise<RingGroup | undefined> =>
      db
        .scoped(ctx)
        .selectFrom('ring_groups')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : toRingGroup(row))),

    async create(ctx: DbContext, input: CreateRingGroupInput): Promise<RingGroup> {
      const { tenantId } = requireTenant(ctx);
      const label = validateLabel(input.label);
      const strategy = validateStrategy(input.strategy);
      const memberExtensionIds = validateMemberExtensionIds(input.memberExtensionIds);
      const ringTimeoutSeconds = validateRingTimeoutSeconds(input.ringTimeoutSeconds);
      const noAnswerDestination = validateNoAnswerDestination(
        input.noAnswerDestinationType,
        input.noAnswerDestinationId,
      );

      const extensionsToCheck =
        noAnswerDestination?.type === 'extension'
          ? [...memberExtensionIds, noAnswerDestination.id]
          : memberExtensionIds;
      await assertExtensionsExist(db, ctx, extensionsToCheck);

      const id = randomUUID();
      const now = new Date();

      await db.scoped(ctx).transaction(async (trx, raw) => {
        await trx
          .insertInto('ring_groups')
          .values({
            id,
            label,
            strategy,
            member_extension_ids: JSON.stringify(memberExtensionIds),
            ring_timeout_seconds: ringTimeoutSeconds,
            no_answer_destination_type: noAnswerDestination?.type ?? null,
            no_answer_destination_id: noAnswerDestination?.id ?? null,
            created_at: now,
            updated_at: now,
            version: 1,
          })
          .execute();

        await enqueueEvent(raw, pbxEvents, {
          type: 'pbx.ring_group.created',
          data: { ringGroupId: id },
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
        memberExtensionIds,
        ringTimeoutSeconds,
        noAnswerDestinationType: noAnswerDestination?.type ?? null,
        noAnswerDestinationId: noAnswerDestination?.id ?? null,
      };
    },

    async update(ctx: DbContext, id: string, input: UpdateRingGroupInput): Promise<RingGroup> {
      const { tenantId } = requireTenant(ctx);
      const existing = await db
        .scoped(ctx)
        .selectFrom('ring_groups')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing === undefined) throw new RingGroupNotFoundError(`No ring group with id '${id}'.`);
      const current = toRingGroup(existing);

      const label = input.label === undefined ? current.label : validateLabel(input.label);
      const strategy =
        input.strategy === undefined ? current.strategy : validateStrategy(input.strategy);
      const memberExtensionIds =
        input.memberExtensionIds === undefined
          ? [...current.memberExtensionIds]
          : validateMemberExtensionIds(input.memberExtensionIds);
      const ringTimeoutSeconds =
        input.ringTimeoutSeconds === undefined
          ? current.ringTimeoutSeconds
          : validateRingTimeoutSeconds(input.ringTimeoutSeconds);
      const noAnswerDestination =
        input.noAnswerDestinationType === undefined && input.noAnswerDestinationId === undefined
          ? current.noAnswerDestinationType === null
            ? null
            : { type: current.noAnswerDestinationType, id: current.noAnswerDestinationId as string }
          : validateNoAnswerDestination(input.noAnswerDestinationType, input.noAnswerDestinationId);

      const extensionsToCheck =
        noAnswerDestination?.type === 'extension'
          ? [...memberExtensionIds, noAnswerDestination.id]
          : memberExtensionIds;
      await assertExtensionsExist(db, ctx, extensionsToCheck);

      await db.scoped(ctx).transaction(async (trx, raw) => {
        await trx
          .updateTable('ring_groups')
          .set({
            label,
            strategy,
            member_extension_ids: JSON.stringify(memberExtensionIds),
            ring_timeout_seconds: ringTimeoutSeconds,
            no_answer_destination_type: noAnswerDestination?.type ?? null,
            no_answer_destination_id: noAnswerDestination?.id ?? null,
            updated_at: new Date(),
            version: existing.version + 1,
          })
          .where('id', '=', id)
          .execute();

        await enqueueEvent(raw, pbxEvents, {
          type: 'pbx.ring_group.updated',
          data: { ringGroupId: id },
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
        memberExtensionIds,
        ringTimeoutSeconds,
        noAnswerDestinationType: noAnswerDestination?.type ?? null,
        noAnswerDestinationId: noAnswerDestination?.id ?? null,
      };
    },

    async remove(ctx: DbContext, id: string): Promise<void> {
      const { tenantId } = requireTenant(ctx);

      await db.scoped(ctx).transaction(async (trx, raw) => {
        const result = await trx.deleteFrom('ring_groups').where('id', '=', id).executeTakeFirst();
        if (Number(result.numDeletedRows) === 0) {
          throw new RingGroupNotFoundError(`No ring group with id '${id}'.`);
        }

        await enqueueEvent(raw, pbxEvents, {
          type: 'pbx.ring_group.deleted',
          data: { ringGroupId: id },
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

export type RingGroupRepo = ReturnType<typeof createRingGroupRepo>;
