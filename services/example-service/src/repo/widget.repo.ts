import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import { widgetEvents } from '../events.js';
import type { ExampleServiceDb } from '../schema.js';

export interface Widget {
  readonly id: string;
  readonly name: string;
}

/**
 * Data access for widgets.
 *
 * Every query goes through `scoped(ctx)`, which applies the tenant predicate and
 * sets `tenant_id` on insert (CLAUDE.md rule 2). Reaching for `db.kysely` here
 * would skip that, and the repository's cross-tenant probe would catch it.
 */
export function createWidgetRepo(db: Database<ExampleServiceDb>) {
  return {
    list: (ctx: DbContext): Promise<Widget[]> =>
      db
        .scoped(ctx)
        .selectFrom('widgets')
        .select(['id', 'name'])
        .orderBy('created_at', 'asc')
        .execute(),

    findById: (ctx: DbContext, id: string): Promise<Widget | undefined> =>
      db
        .scoped(ctx)
        .selectFrom('widgets')
        .select(['id', 'name'])
        .where('id', '=', id)
        .executeTakeFirst(),

    /**
     * Writes the row and its event in one transaction, so the event can never
     * describe a write that did not happen (CLAUDE.md rule 6).
     */
    async create(ctx: DbContext, name: string): Promise<Widget> {
      const id = randomUUID();
      const now = new Date();

      await db.scoped(ctx).transaction(async (trx, raw) => {
        await trx
          .insertInto('widgets')
          .values({ id, name, created_at: now, updated_at: now, version: 1 })
          .execute();

        // `raw` is the outbox's home: outbox.tenant_id is nullable (a
        // master-level event belongs to no tenant), so it is never reached
        // through scoped(ctx). Same transaction as the insert above, so the row
        // and its event commit or roll back together.
        await enqueueEvent(raw, widgetEvents, {
          type: 'pbx.widget.created',
          data: { widgetId: id, name },
          ...(ctx.tenantId === undefined ? {} : { orgContext: { tenantId: ctx.tenantId } }),
          ...(ctx.actorId === undefined || ctx.orgId === undefined
            ? {}
            : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });

      return { id, name };
    },
  };
}

export type WidgetRepo = ReturnType<typeof createWidgetRepo>;
