import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import { {{entity}}Events } from '../events.js';
import type { {{Pascal}}Db } from '../schema.js';

export interface {{Entity}} {
  readonly id: string;
  readonly name: string;
}

/**
 * Data access for {{table}}.
 *
 * Every query goes through `scoped(ctx)`, which applies the tenant predicate and
 * sets `tenant_id` on insert (CLAUDE.md rule 2). Reaching for `db.kysely` here
 * would skip that, and the repository's cross-tenant probe would catch it.
 */
export function create{{Entity}}Repo(db: Database<{{Pascal}}Db>) {
  return {
    list: (ctx: DbContext): Promise<{{Entity}}[]> =>
      db
        .scoped(ctx)
        .selectFrom('{{table}}')
        .select(['id', 'name'])
        .orderBy('created_at', 'asc')
        .execute(),

    findById: (ctx: DbContext, id: string): Promise<{{Entity}} | undefined> =>
      db
        .scoped(ctx)
        .selectFrom('{{table}}')
        .select(['id', 'name'])
        .where('id', '=', id)
        .executeTakeFirst(),

    /**
     * Writes the row and its event in one transaction, so the event can never
     * describe a write that did not happen (CLAUDE.md rule 6).
     */
    async create(ctx: DbContext, name: string): Promise<{{Entity}}> {
      const id = randomUUID();
      const now = new Date();

      await db.scoped(ctx).transaction(async (trx, raw) => {
        await trx
          .insertInto('{{table}}')
          .values({ id, name, created_at: now, updated_at: now, version: 1 })
          .execute();

        // `raw` is the outbox's home: outbox.tenant_id is nullable (a
        // master-level event belongs to no tenant), so it is never reached
        // through scoped(ctx). Same transaction as the insert above, so the row
        // and its event commit or roll back together.
        await enqueueEvent(raw, {{entity}}Events, {
          type: '{{domain}}.{{entity}}.created',
          data: { {{entity}}Id: id, name },
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

export type {{Entity}}Repo = ReturnType<typeof create{{Entity}}Repo>;
