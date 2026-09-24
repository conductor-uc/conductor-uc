import type { Database, DbContext } from '@cuc/db';
import { requireTenant } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import {
  allDestinations,
  closesForwardAlwaysLoop,
  DEFAULT_CALL_HANDLING,
  destinationExtensionId,
  InvalidCallHandlingError,
  validateCallHandling,
  type CallHandling,
  type CallHandlingInput,
  type Destination,
  type DndAction,
} from '../domain/call-handling.js';
import { pbxEvents } from '../events.js';
import type { PbxConfigServiceDb } from '../schema.js';

export class CallHandlingExtensionNotFoundError extends Error {
  override readonly name = 'CallHandlingExtensionNotFoundError';
}

interface CallHandlingRow {
  extension_id: string;
  dnd: boolean | number;
  dnd_action: string;
  forward_always: unknown;
  forward_busy: unknown;
  forward_no_answer: unknown;
  no_answer_seconds: number;
  forward_unreachable: unknown;
  simultaneous_ring: unknown;
}

/** MariaDB's `json` columns come back parsed or as text depending on the driver. */
function parseJson<T>(value: unknown): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : (value as T);
}

function destinationOf(value: unknown): Destination | null {
  if (value === null || value === undefined) return null;
  return parseJson<Destination | null>(value);
}

function toCallHandling(row: CallHandlingRow): CallHandling {
  return {
    dnd: Boolean(row.dnd),
    dndAction: row.dnd_action as DndAction,
    forwardAlways: destinationOf(row.forward_always),
    forwardBusy: destinationOf(row.forward_busy),
    forwardNoAnswer: destinationOf(row.forward_no_answer),
    noAnswerSeconds: row.no_answer_seconds,
    forwardUnreachable: destinationOf(row.forward_unreachable),
    simultaneousRing: parseJson<Destination[]>(row.simultaneous_ring ?? '[]'),
  };
}

const json = (value: Destination | null): string | null =>
  value === null ? null : JSON.stringify(value);

/**
 * Data access for per-extension call handling (parity 1a). Every query goes
 * through `scoped(ctx)` (CLAUDE.md rule 2), so another tenant's extension id
 * simply is not found; each change publishes a thin
 * `pbx.call_handling.updated` event through the outbox (rule 6).
 */
export function createCallHandlingRepo(db: Database<PbxConfigServiceDb>) {
  async function requireExtension(ctx: DbContext, extensionId: string): Promise<void> {
    const found = await db
      .scoped(ctx)
      .selectFrom('extensions')
      .select('id')
      .where('id', '=', extensionId)
      .executeTakeFirst();
    if (found === undefined) {
      throw new CallHandlingExtensionNotFoundError(`No extension with id '${extensionId}'.`);
    }
  }

  return {
    /**
     * An extension's call handling; the all-off default when nothing has been
     * saved. Throws when the extension is not in this tenant.
     */
    async get(ctx: DbContext, extensionId: string): Promise<CallHandling> {
      await requireExtension(ctx, extensionId);
      const row = await db
        .scoped(ctx)
        .selectFrom('extension_call_handling')
        .selectAll()
        .where('extension_id', '=', extensionId)
        .executeTakeFirst();
      return row === undefined ? DEFAULT_CALL_HANDLING : toCallHandling(row);
    },

    /** Same as {@link get}, but `undefined` instead of the default: for telephony-config's mirror, which stores only what exists. */
    async find(ctx: DbContext, extensionId: string): Promise<CallHandling | undefined> {
      const row = await db
        .scoped(ctx)
        .selectFrom('extension_call_handling')
        .selectAll()
        .where('extension_id', '=', extensionId)
        .executeTakeFirst();
      return row === undefined ? undefined : toCallHandling(row);
    },

    /** Every configured extension in the tenant, for telephony-config's reconciliation. */
    async listForTenant(
      ctx: DbContext,
    ): Promise<{ extensionId: string; handling: CallHandling }[]> {
      const rows = await db
        .scoped(ctx)
        .selectFrom('extension_call_handling')
        .selectAll()
        .orderBy('extension_id', 'asc')
        .execute();
      return rows.map((row) => ({ extensionId: row.extension_id, handling: toCallHandling(row) }));
    },

    /**
     * Replaces an extension's call handling. Validates the document, checks
     * every extension it names is in this tenant, and refuses a forward-always
     * chain that would loop back to this extension.
     */
    async put(
      ctx: DbContext,
      extensionId: string,
      input: CallHandlingInput,
    ): Promise<CallHandling> {
      const { tenantId } = requireTenant(ctx);
      await requireExtension(ctx, extensionId);
      const handling = validateCallHandling(input, extensionId);

      const referenced = [
        ...new Set(
          allDestinations(handling)
            .map(destinationExtensionId)
            .filter((id): id is string => id !== undefined),
        ),
      ];
      if (referenced.length > 0) {
        const found = await db
          .scoped(ctx)
          .selectFrom('extensions')
          .select('id')
          .where('id', 'in', referenced)
          .execute();
        const known = new Set(found.map((r) => r.id));
        const missing = referenced.find((id) => !known.has(id));
        if (missing !== undefined) {
          throw new InvalidCallHandlingError(
            `Extension '${missing}' does not exist in this tenant.`,
          );
        }
      }

      if (handling.forwardAlways?.type === 'extension') {
        const others = await db
          .scoped(ctx)
          .selectFrom('extension_call_handling')
          .select(['extension_id', 'forward_always'])
          .where('extension_id', '!=', extensionId)
          .execute();
        const edges = new Map<string, string>();
        for (const row of others) {
          const target = destinationOf(row.forward_always);
          if (target?.type === 'extension') edges.set(row.extension_id, target.extensionId);
        }
        if (closesForwardAlwaysLoop(extensionId, handling.forwardAlways.extensionId, edges)) {
          throw new InvalidCallHandlingError(
            'forwardAlways: that would make a forwarding loop back to this extension.',
          );
        }
      }

      const now = new Date();
      await db.scoped(ctx).transaction(async (trx, raw) => {
        const existing = await trx
          .selectFrom('extension_call_handling')
          .select(['version'])
          .where('extension_id', '=', extensionId)
          .executeTakeFirst();

        const columns = {
          dnd: handling.dnd,
          dnd_action: handling.dndAction,
          forward_always: json(handling.forwardAlways),
          forward_busy: json(handling.forwardBusy),
          forward_no_answer: json(handling.forwardNoAnswer),
          no_answer_seconds: handling.noAnswerSeconds,
          forward_unreachable: json(handling.forwardUnreachable),
          simultaneous_ring: JSON.stringify(handling.simultaneousRing),
          updated_at: now,
        };
        if (existing === undefined) {
          await trx
            .insertInto('extension_call_handling')
            .values({ extension_id: extensionId, ...columns, created_at: now, version: 1 })
            .execute();
        } else {
          await trx
            .updateTable('extension_call_handling')
            .set({ ...columns, version: existing.version + 1 })
            .where('extension_id', '=', extensionId)
            .execute();
        }

        await enqueueEvent(raw, pbxEvents, {
          type: 'pbx.call_handling.updated',
          data: { extensionId },
          orgContext: { tenantId },
          ...(ctx.actorId === undefined || ctx.orgId === undefined
            ? {}
            : { actor: { type: 'user' as const, id: ctx.actorId, orgId: ctx.orgId } }),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });

      return handling;
    },
  };
}

export type CallHandlingRepo = ReturnType<typeof createCallHandlingRepo>;
