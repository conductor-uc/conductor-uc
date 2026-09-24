import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { isDuplicateKeyError, requireTenant } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import type { CdrDirection, CdrDisposition, CdrHangupBy, NormalizedCdr } from '../domain/cdr.js';
import { cdrEvents } from '../events.js';
import type { CdrServiceDb } from '../schema.js';

export interface Cdr {
  readonly id: string;
  readonly tenantId: string;
  readonly resellerId: string | null;
  readonly callUuid: string;
  readonly nodeId: string;
  readonly direction: CdrDirection;
  readonly startAt: Date;
  readonly answerAt: Date | null;
  readonly endAt: Date;
  readonly durationSec: number;
  readonly billableSec: number;
  readonly fromNumber: string;
  readonly fromName: string | null;
  readonly toNumber: string;
  readonly dialedNumber: string;
  readonly did: string | null;
  readonly trunkId: string | null;
  readonly extensionIds: readonly string[];
  readonly disposition: CdrDisposition;
  readonly hangupCause: string;
  readonly hangupBy: CdrHangupBy;
  readonly queueId: string | null;
  readonly flowId: string | null;
  readonly recordingIds: readonly string[];
  readonly legs: unknown;
  readonly sip: Record<string, unknown>;
}

export interface CdrListFilter {
  readonly from?: Date;
  readonly to?: Date;
  readonly direction?: CdrDirection;
  readonly did?: string;
  /** Calls to, from or dialed as this number (an extension number or an E.164 number), exact match. */
  readonly number?: string;
  readonly limit?: number;
  /** Opaque, from a previous page's `nextCursor` — {@link encodeCursor}/{@link decodeCursor}. */
  readonly cursor?: string;
}

export interface CdrListPage {
  readonly rows: Cdr[];
  readonly nextCursor: string | null;
}

/** Already ingested (dedupe hit on `(call_uuid, node_id, start_at)`) — not an error, the caller should treat this as success. */
export class CdrAlreadyIngestedError extends Error {
  override readonly name = 'CdrAlreadyIngestedError';
}

export class CdrNotFoundError extends Error {
  override readonly name = 'CdrNotFoundError';
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

interface CdrRow {
  id: string;
  tenant_id: string;
  reseller_id: string | null;
  call_uuid: string;
  node_id: string;
  direction: string;
  start_at: Date;
  answer_at: Date | null;
  end_at: Date;
  duration_sec: number;
  billable_sec: number;
  from_number: string;
  from_name: string | null;
  to_number: string;
  dialed_number: string;
  did: string | null;
  trunk_id: string | null;
  extension_ids: string;
  disposition: string;
  hangup_cause: string;
  hangup_by: string;
  queue_id: string | null;
  flow_id: string | null;
  recording_ids: string;
  legs: string | null;
  sip: string | null;
}

function toCdr(row: CdrRow): Cdr {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    resellerId: row.reseller_id,
    callUuid: row.call_uuid,
    nodeId: row.node_id,
    direction: row.direction as CdrDirection,
    startAt: row.start_at,
    answerAt: row.answer_at,
    endAt: row.end_at,
    durationSec: row.duration_sec,
    billableSec: row.billable_sec,
    fromNumber: row.from_number,
    fromName: row.from_name,
    toNumber: row.to_number,
    dialedNumber: row.dialed_number,
    did: row.did,
    trunkId: row.trunk_id,
    extensionIds: JSON.parse(row.extension_ids) as string[],
    disposition: row.disposition as CdrDisposition,
    hangupCause: row.hangup_cause,
    hangupBy: row.hangup_by as CdrHangupBy,
    queueId: row.queue_id,
    flowId: row.flow_id,
    recordingIds: JSON.parse(row.recording_ids) as string[],
    legs: row.legs === null ? null : (JSON.parse(row.legs) as unknown),
    sip: row.sip === null ? {} : (JSON.parse(row.sip) as Record<string, unknown>),
  };
}

/** `(startAt, id)` keyset cursor, base64url — opaque to callers, ordered the same way `list` sorts (`start_at desc, id desc`). */
function encodeCursor(startAt: Date, id: string): string {
  return Buffer.from(`${startAt.toISOString()}:${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { startAt: Date; id: string } {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = decoded.lastIndexOf(':');
  if (separator === -1) throw new Error(`Malformed cursor '${cursor}'.`);
  const startAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(startAt.getTime()) || id === '') {
    throw new Error(`Malformed cursor '${cursor}'.`);
  }
  return { startAt, id };
}

/**
 * Data access for CDRs (S2-18; 06's cdr-service section). Every query goes
 * through `scoped(ctx)` (CLAUDE.md rule 2). `ingest` is the only writer —
 * there is no CRUD surface here the way pbx-config-service has, since a CDR
 * is never edited, only ever produced once by `mod_json_cdr`'s own POST.
 */
export function createCdrRepo(db: Database<CdrServiceDb>) {
  return {
    /**
     * Inserts a normalized CDR and enqueues `cdr.record.created`, or throws
     * {@link CdrAlreadyIngestedError} on a dedupe hit (`mod_json_cdr`'s own
     * documented retry-on-failure behavior, 07 §1) — the caller (the ingest
     * route) treats that as success, not a failure to surface to FS.
     */
    async ingest(normalized: NormalizedCdr, resellerId: string | null): Promise<Cdr> {
      const id = randomUUID();
      const now = new Date();

      const cdr: Cdr = {
        id,
        tenantId: normalized.tenantId,
        resellerId,
        callUuid: normalized.callUuid,
        nodeId: normalized.nodeId,
        direction: normalized.direction,
        startAt: normalized.startAt,
        answerAt: normalized.answerAt,
        endAt: normalized.endAt,
        durationSec: normalized.durationSec,
        billableSec: normalized.billableSec,
        fromNumber: normalized.fromNumber,
        fromName: normalized.fromName,
        toNumber: normalized.toNumber,
        dialedNumber: normalized.dialedNumber,
        did: normalized.did,
        trunkId: normalized.trunkId,
        extensionIds: [],
        disposition: normalized.disposition,
        hangupCause: normalized.hangupCause,
        hangupBy: normalized.hangupBy,
        queueId: null,
        flowId: null,
        recordingIds: [],
        legs: normalized.legs,
        sip: normalized.sip,
      };

      try {
        await db.scoped({ tenantId: normalized.tenantId }).transaction(async (trx, raw) => {
          await trx
            .insertInto('cdrs')
            .values({
              id,
              reseller_id: resellerId,
              call_uuid: normalized.callUuid,
              node_id: normalized.nodeId,
              direction: normalized.direction,
              start_at: normalized.startAt,
              answer_at: normalized.answerAt,
              end_at: normalized.endAt,
              duration_sec: normalized.durationSec,
              billable_sec: normalized.billableSec,
              from_number: normalized.fromNumber,
              from_name: normalized.fromName,
              to_number: normalized.toNumber,
              dialed_number: normalized.dialedNumber,
              did: normalized.did,
              trunk_id: normalized.trunkId,
              extension_ids: '[]',
              disposition: normalized.disposition,
              hangup_cause: normalized.hangupCause,
              hangup_by: normalized.hangupBy,
              queue_id: null,
              flow_id: null,
              recording_ids: '[]',
              legs: normalized.legs === null ? null : JSON.stringify(normalized.legs),
              sip: JSON.stringify(normalized.sip),
              created_at: now,
            })
            .execute();

          await enqueueEvent(raw, cdrEvents, {
            type: 'cdr.record.created',
            data: { cdrId: id, tenantId: normalized.tenantId },
            orgContext: { tenantId: normalized.tenantId },
          });
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new CdrAlreadyIngestedError(
            `CDR for call '${normalized.callUuid}' on node '${normalized.nodeId}' was already ingested.`,
          );
        }
        throw error;
      }

      return cdr;
    },

    findById(ctx: DbContext, id: string): Promise<Cdr | undefined> {
      return db
        .scoped(ctx)
        .selectFrom('cdrs')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : toCdr(row)));
    },

    async list(ctx: DbContext, filter: CdrListFilter = {}): Promise<CdrListPage> {
      const { tenantId } = requireTenant(ctx);
      const limit = Math.min(filter.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);

      let query = db.scoped(ctx).selectFrom('cdrs').selectAll().where('tenant_id', '=', tenantId);
      if (filter.from !== undefined) query = query.where('start_at', '>=', filter.from);
      if (filter.to !== undefined) query = query.where('start_at', '<=', filter.to);
      if (filter.direction !== undefined) query = query.where('direction', '=', filter.direction);
      if (filter.did !== undefined) query = query.where('did', '=', filter.did);
      if (filter.number !== undefined) {
        const number = filter.number;
        query = query.where((eb) =>
          eb.or([
            eb('from_number', '=', number),
            eb('to_number', '=', number),
            eb('dialed_number', '=', number),
          ]),
        );
      }
      if (filter.cursor !== undefined) {
        const { startAt, id } = decodeCursor(filter.cursor);
        query = query.where((eb) =>
          eb.or([
            eb('start_at', '<', startAt),
            eb.and([eb('start_at', '=', startAt), eb('id', '<', id)]),
          ]),
        );
      }

      const rows = await query
        .orderBy('start_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1)
        .execute();

      const page = rows.slice(0, limit).map(toCdr);
      const hasMore = rows.length > limit;
      const last = page.at(-1);
      const nextCursor = hasMore && last !== undefined ? encodeCursor(last.startAt, last.id) : null;

      return { rows: page, nextCursor };
    },

    /**
     * Every CDR for `tenantId` in `[fromAt, toAt]`, walking `list`'s own
     * cursor internally — the export consumer's own reader
     * (`consumers/export.consumer.ts`), not the paginated public API.
     * `domain/export.ts`'s `validateExportRange` already bounds how wide a
     * range this can be asked to walk.
     */
    async listAllInRange(tenantId: string, fromAt: Date, toAt: Date): Promise<Cdr[]> {
      const all: Cdr[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await this.list(
          { tenantId },
          {
            from: fromAt,
            to: toAt,
            limit: MAX_LIST_LIMIT,
            ...(cursor === undefined ? {} : { cursor }),
          },
        );
        all.push(...page.rows);
        if (page.nextCursor === null) return all;
        cursor = page.nextCursor;
      }
    },
  };
}

export type CdrRepo = ReturnType<typeof createCdrRepo>;
