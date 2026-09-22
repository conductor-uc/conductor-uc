import { randomUUID } from 'node:crypto';

import { compileGraph, CompileError, validateGraph } from '@cuc/callflow-ir';
import type { FlowGraphInput, FlowIR, ValidationIssue } from '@cuc/callflow-ir';
import type { Database, DbContext } from '@cuc/db';
import { requireTenant } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import { EMPTY_DRAFT_GRAPH } from '../domain/flow.js';
import { flowEvents } from '../events.js';
import type { CallflowServiceDb } from '../schema.js';

export interface FlowSummary {
  readonly id: string;
  readonly name: string;
  readonly currentPublishedVersionId: string | null;
}

export interface Flow extends FlowSummary {
  readonly draftGraph: FlowGraphInput;
  readonly draftUpdatedAt: Date;
}

export interface FlowVersionSummary {
  readonly id: string;
  readonly versionNumber: number;
  readonly publishedAt: Date;
}

/**
 * A flow's currently published IR together with the identity of the version
 * it came from — the exact payload the internal IR endpoint returns, and what
 * S2-10's `flow_runner.lua` keys its on-disk cache on.
 */
export interface PublishedIr {
  readonly flowId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly ir: FlowIR;
}

export class FlowNotFoundError extends Error {
  override readonly name = 'FlowNotFoundError';
}

export class FlowVersionNotFoundError extends Error {
  override readonly name = 'FlowVersionNotFoundError';
}

/** The draft fails `validateGraph` — carries every issue, not just the first. */
export class InvalidDraftGraphError extends Error {
  override readonly name = 'InvalidDraftGraphError';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(
      `Draft graph is not valid:\n${issues.map((i) => `  - [${i.kind}] ${i.message}`).join('\n')}`,
    );
    this.issues = issues;
  }
}

const FLOW_COLUMNS = [
  'id',
  'name',
  'draft_graph as draftGraph',
  'draft_updated_at as draftUpdatedAt',
  'current_published_version_id as currentPublishedVersionId',
] as const;

/** MariaDB's `json` columns may come back already-parsed or as a raw string, depending on driver version — same defensive check as trunk-service's own JSON columns. */
function parseJson<T>(value: unknown): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : (value as T);
}

function toFlow(row: {
  id: string;
  name: string;
  draftGraph: unknown;
  draftUpdatedAt: Date;
  currentPublishedVersionId: string | null;
}): Flow {
  return {
    id: row.id,
    name: row.name,
    draftGraph: parseJson<FlowGraphInput>(row.draftGraph),
    draftUpdatedAt: row.draftUpdatedAt,
    currentPublishedVersionId: row.currentPublishedVersionId,
  };
}

/**
 * Data access for flows: the mutable draft plus the immutable published
 * version history (S2-09). Every query goes through `scoped(ctx)`
 * (CLAUDE.md rule 2).
 *
 * `:publish` and `:rollback` both write the row and enqueue
 * `callflow.flow.published` in the same transaction, so the event can never
 * describe a write that did not happen (CLAUDE.md rule 6).
 */
export function createFlowRepo(db: Database<CallflowServiceDb>) {
  return {
    async list(ctx: DbContext): Promise<FlowSummary[]> {
      const rows = await db
        .scoped(ctx)
        .selectFrom('flows')
        .select(['id', 'name', 'current_published_version_id as currentPublishedVersionId'])
        .orderBy('created_at', 'asc')
        .execute();
      return rows;
    },

    async findById(ctx: DbContext, id: string): Promise<Flow | undefined> {
      const row = await db
        .scoped(ctx)
        .selectFrom('flows')
        .select(FLOW_COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst();
      return row === undefined ? undefined : toFlow(row);
    },

    async listVersions(ctx: DbContext, flowId: string): Promise<FlowVersionSummary[]> {
      const rows = await db
        .scoped(ctx)
        .selectFrom('flow_versions')
        .select(['id', 'version_number as versionNumber', 'published_at as publishedAt'])
        .where('flow_id', '=', flowId)
        .orderBy('version_number', 'asc')
        .execute();
      return rows;
    },

    /**
     * Creates a flow with an empty draft. No event fires — the plan defines
     * only `callflow.flow.published` (05 §5), and nothing needs to know a
     * flow exists before it has ever been published; `:publish` is the first
     * write a consumer cares about.
     */
    async create(ctx: DbContext, name: string): Promise<Flow> {
      const id = randomUUID();
      const now = new Date();

      await db
        .scoped(ctx)
        .insertInto('flows')
        .values({
          id,
          name,
          draft_graph: JSON.stringify(EMPTY_DRAFT_GRAPH),
          draft_updated_at: now,
          current_published_version_id: null,
          created_at: now,
          updated_at: now,
          version: 1,
        })
        .execute();

      return {
        id,
        name,
        draftGraph: EMPTY_DRAFT_GRAPH,
        draftUpdatedAt: now,
        currentPublishedVersionId: null,
      };
    },

    /** Replaces the draft graph wholesale. Does not touch published versions. */
    async updateDraft(ctx: DbContext, id: string, graph: FlowGraphInput): Promise<Flow> {
      const existing = await this.findById(ctx, id);
      if (existing === undefined) throw new FlowNotFoundError(`No flow with id '${id}'.`);

      const now = new Date();
      await db
        .scoped(ctx)
        .updateTable('flows')
        .set({ draft_graph: JSON.stringify(graph), draft_updated_at: now, updated_at: now })
        .where('id', '=', id)
        .execute();

      return { ...existing, draftGraph: graph, draftUpdatedAt: now };
    },

    /** Pure check, no write: runs the current draft through `validateGraph`. */
    async validateDraft(ctx: DbContext, id: string): Promise<ValidationIssue[]> {
      const existing = await this.findById(ctx, id);
      if (existing === undefined) throw new FlowNotFoundError(`No flow with id '${id}'.`);
      return validateGraph(existing.draftGraph);
    },

    /**
     * Compiles the current draft and, if valid, publishes it as a new
     * immutable version — the next `version_number` for this flow, never
     * reused even across `rollback`. The prior published version's row is
     * untouched; only `flows.current_published_version_id` moves.
     */
    async publish(ctx: DbContext, id: string): Promise<FlowVersionSummary> {
      const { tenantId } = requireTenant(ctx);
      const existing = await this.findById(ctx, id);
      if (existing === undefined) throw new FlowNotFoundError(`No flow with id '${id}'.`);

      let ir: FlowIR;
      try {
        ir = compileGraph(existing.draftGraph);
      } catch (error) {
        if (error instanceof CompileError) throw new InvalidDraftGraphError(error.issues);
        throw error;
      }

      const versionId = randomUUID();
      const now = new Date();
      let versionNumber = 0;

      await db.scoped(ctx).transaction(async (trx, raw) => {
        const highest = await trx
          .selectFrom('flow_versions')
          .select(['version_number as versionNumber'])
          .where('flow_id', '=', id)
          .orderBy('version_number', 'desc')
          .executeTakeFirst();
        versionNumber = (highest?.versionNumber ?? 0) + 1;

        await trx
          .insertInto('flow_versions')
          .values({
            id: versionId,
            flow_id: id,
            version_number: versionNumber,
            graph: JSON.stringify(existing.draftGraph),
            ir: JSON.stringify(ir),
            published_at: now,
          })
          .execute();

        await trx
          .updateTable('flows')
          .set({ current_published_version_id: versionId, updated_at: now })
          .where('id', '=', id)
          .execute();

        await enqueueEvent(raw, flowEvents, {
          type: 'callflow.flow.published',
          data: { flowId: id, versionId, versionNumber },
          orgContext: { tenantId },
          ...(ctx.actorId === undefined || ctx.orgId === undefined
            ? {}
            : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });

      return { id: versionId, versionNumber, publishedAt: now };
    },

    /**
     * Repoints the flow's current published version to an earlier, already-
     * published one. Creates no new version row — the target version's own
     * row (and its `version_number`) is unchanged; only `flows` moves.
     */
    async rollback(ctx: DbContext, id: string, versionNumber: number): Promise<FlowVersionSummary> {
      const { tenantId } = requireTenant(ctx);
      const existing = await this.findById(ctx, id);
      if (existing === undefined) throw new FlowNotFoundError(`No flow with id '${id}'.`);

      let result: FlowVersionSummary | undefined;

      await db.scoped(ctx).transaction(async (trx, raw) => {
        const target = await trx
          .selectFrom('flow_versions')
          .select(['id', 'version_number as versionNumber', 'published_at as publishedAt'])
          .where('flow_id', '=', id)
          .where('version_number', '=', versionNumber)
          .executeTakeFirst();
        if (target === undefined) {
          throw new FlowVersionNotFoundError(
            `Flow '${id}' has no published version number ${String(versionNumber)}.`,
          );
        }

        await trx
          .updateTable('flows')
          .set({ current_published_version_id: target.id, updated_at: new Date() })
          .where('id', '=', id)
          .execute();

        await enqueueEvent(raw, flowEvents, {
          type: 'callflow.flow.published',
          data: { flowId: id, versionId: target.id, versionNumber: target.versionNumber },
          orgContext: { tenantId },
          ...(ctx.actorId === undefined || ctx.orgId === undefined
            ? {}
            : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });

        result = target;
      });

      return result!;
    },

    /** The internal IR endpoint's own lookup: the current published version's compiled IR, or `undefined` if the flow has never published. */
    async findPublishedIr(ctx: DbContext, id: string): Promise<FlowIR | undefined> {
      const published = await this.findPublishedIrWithVersion(ctx, id);
      return published === undefined ? undefined : published.ir;
    },

    /**
     * The same lookup, plus the version identity S2-10's `flow_runner.lua`
     * caches the IR on disk by.
     *
     * The runner cannot cache on the flow id alone — it would then never
     * notice a `:publish`, and "a published new version takes effect on the
     * next call" (S2-10's own "Done when") would be false until the node
     * restarted.
     *
     * `versionNumber` is safe as a cache key because a version's `ir` is
     * immutable once written: version N of a flow always means exactly one
     * graph. Note that a rollback *repoints* at an existing version row
     * rather than publishing a new one, so the number can go backwards — that
     * is still correct here, because the cache file for version N holds
     * version N's IR either way. What must never happen is the same number
     * meaning two different graphs, and the immutability of `flow_versions`
     * is what rules that out.
     */
    async findPublishedIrWithVersion(ctx: DbContext, id: string): Promise<PublishedIr | undefined> {
      const flow = await this.findById(ctx, id);
      if (flow === undefined || flow.currentPublishedVersionId === null) return undefined;

      const row = await db
        .scoped(ctx)
        .selectFrom('flow_versions')
        .select(['id', 'version_number as versionNumber', 'ir'])
        .where('id', '=', flow.currentPublishedVersionId)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      return {
        flowId: id,
        versionId: row.id,
        versionNumber: row.versionNumber,
        ir: parseJson<FlowIR>(row.ir),
      };
    },
  };
}

export type FlowRepo = ReturnType<typeof createFlowRepo>;
