import { randomUUID } from 'node:crypto';

import { recordAuditEvent, type AuditEventInput } from '@cuc/audit';
import { requireTenant, type Database, type DbContext, type ScopedDb } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import type { CallDirection } from '../domain/policy.js';
import {
  closeOpenPause,
  parsePauseIntervals,
  RECORDING_CONTENT_TYPE,
  recordingObjectKey,
  serializePauseIntervals,
  togglePauseIntervals,
  type PauseInterval,
  type RecordingStatus,
} from '../domain/recording.js';
import { retentionDateFor } from '../domain/retention.js';
import { recordingEvents } from '../events.js';
import type { RecordingServiceDb } from '../schema.js';

export interface Recording {
  readonly id: string;
  readonly tenantId: string;
  readonly callUuid: string;
  readonly extensionId: string | null;
  readonly peerExtensionId: string | null;
  readonly queueId: string | null;
  readonly didId: string | null;
  readonly direction: CallDirection;
  readonly policyId: string | null;
  readonly nodeId: string | null;
  readonly announced: boolean;
  readonly status: RecordingStatus;
  readonly objectKey: string;
  readonly contentType: string;
  readonly startedAt: Date;
  readonly durationMs: number | null;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
  readonly failureReason: string | null;
  readonly retentionDate: Date | null;
  /** S5-13: started by a feature code rather than by a rule. */
  readonly onDemand: boolean;
  /** S5-13: when an on-demand recording was stopped by feature code. */
  readonly stoppedAt: Date | null;
  /** S5-13: the pauses, oldest first; an open one (`to` null) means paused now. */
  readonly pauses: readonly PauseInterval[];
}

export class RecordingNotFoundError extends Error {
  override readonly name = 'RecordingNotFoundError';
}

export class RecordingStateError extends Error {
  override readonly name = 'RecordingStateError';
}

export interface RegisterRecordingInput {
  readonly callUuid: string;
  readonly direction: CallDirection;
  readonly extensionId?: string | null | undefined;
  readonly peerExtensionId?: string | null | undefined;
  readonly queueId?: string | null | undefined;
  readonly didId?: string | null | undefined;
  readonly policyId?: string | null | undefined;
  readonly nodeId?: string | null | undefined;
  readonly announced: boolean;
  /** S5-13: started by a feature code. */
  readonly onDemand?: boolean | undefined;
}

export interface CompleteRecordingInput {
  readonly sizeBytes: number;
  readonly durationMs: number | null;
  readonly sha256: string | null;
  readonly retentionDays: number;
}

export interface RecordingFilter {
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly direction?: CallDirection | undefined;
  readonly extensionId?: string | undefined;
  readonly queueId?: string | undefined;
  readonly didId?: string | undefined;
  readonly callUuid?: string | undefined;
  readonly status?: RecordingStatus | undefined;
  /**
   * Restricts the list to recordings inside these scopes (a supervisor's scoped grants).
   * Undefined means every recording of the tenant.
   */
  readonly visibleScopes?:
    readonly { type: 'extension' | 'queue' | 'did'; id: string }[] | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

const COLUMNS = [
  'id',
  'tenant_id as tenantId',
  'call_uuid as callUuid',
  'extension_id as extensionId',
  'peer_extension_id as peerExtensionId',
  'queue_id as queueId',
  'did_id as didId',
  'direction',
  'policy_id as policyId',
  'node_id as nodeId',
  'announced',
  'status',
  'object_key as objectKey',
  'content_type as contentType',
  'started_at as startedAt',
  'duration_ms as durationMs',
  'size_bytes as sizeBytes',
  'sha256',
  'failure_reason as failureReason',
  'retention_date as retentionDate',
  'on_demand as onDemand',
  'stopped_at as stoppedAt',
  'pause_intervals as pauseIntervals',
] as const;

type Row = {
  id: string;
  tenantId: string;
  callUuid: string;
  extensionId: string | null;
  peerExtensionId: string | null;
  queueId: string | null;
  didId: string | null;
  direction: string;
  policyId: string | null;
  nodeId: string | null;
  announced: boolean | number;
  status: string;
  objectKey: string;
  contentType: string;
  startedAt: Date;
  durationMs: number | null;
  sizeBytes: number | string | bigint | null;
  sha256: string | null;
  failureReason: string | null;
  retentionDate: Date | null;
  onDemand: boolean | number;
  stoppedAt: Date | null;
  pauseIntervals: string | null;
};

function toRecording(row: Row): Recording {
  const { pauseIntervals, ...rest } = row;
  return {
    ...rest,
    direction: row.direction as CallDirection,
    announced: Boolean(row.announced),
    status: row.status as RecordingStatus,
    // BIGINT arrives as a string or bigint from the driver.
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
    onDemand: Boolean(row.onDemand),
    pauses: parsePauseIntervals(pauseIntervals),
  };
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** `(startedAt, id)` keyset cursor, opaque to callers, ordered the way `list` sorts. */
function encodeCursor(startedAt: Date, id: string): string {
  return Buffer.from(`${startedAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export class InvalidCursorError extends Error {
  override readonly name = 'InvalidCursorError';
}

function decodeCursor(cursor: string): { startedAt: Date; id: string } {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = decoded.lastIndexOf('|');
  const startedAt = new Date(separator === -1 ? NaN : decoded.slice(0, separator));
  const id = separator === -1 ? '' : decoded.slice(separator + 1);
  if (Number.isNaN(startedAt.getTime()) || id === '')
    throw new InvalidCursorError('Malformed cursor.');
  return { startedAt, id };
}

/**
 * Inserts a `pending` row and returns it. The id is random and opaque: it becomes the spool file
 * name and the object key, so it must name nothing. Shared by `register` and `startOnDemand`
 * (inside its audit transaction).
 */
async function insertRecording(
  scoped: ScopedDb<RecordingServiceDb>,
  tenantId: string,
  input: RegisterRecordingInput,
): Promise<Recording> {
  const id = randomUUID();
  const now = new Date();
  const objectKey = recordingObjectKey(id, now);
  const onDemand = input.onDemand ?? false;
  await scoped
    .insertInto('recordings')
    .values({
      id,
      call_uuid: input.callUuid,
      extension_id: input.extensionId ?? null,
      peer_extension_id: input.peerExtensionId ?? null,
      queue_id: input.queueId ?? null,
      did_id: input.didId ?? null,
      direction: input.direction,
      policy_id: input.policyId ?? null,
      node_id: input.nodeId ?? null,
      announced: input.announced,
      status: 'pending',
      object_key: objectKey,
      content_type: RECORDING_CONTENT_TYPE,
      started_at: now,
      duration_ms: null,
      size_bytes: null,
      sha256: null,
      failure_reason: null,
      retention_date: null,
      on_demand: onDemand,
      stopped_at: null,
      pause_intervals: null,
      created_at: now,
      updated_at: now,
      version: 1,
    })
    .execute();
  return {
    id,
    tenantId,
    callUuid: input.callUuid,
    extensionId: input.extensionId ?? null,
    peerExtensionId: input.peerExtensionId ?? null,
    queueId: input.queueId ?? null,
    didId: input.didId ?? null,
    direction: input.direction,
    policyId: input.policyId ?? null,
    nodeId: input.nodeId ?? null,
    announced: input.announced,
    status: 'pending',
    objectKey,
    contentType: RECORDING_CONTENT_TYPE,
    startedAt: now,
    durationMs: null,
    sizeBytes: null,
    sha256: null,
    failureReason: null,
    retentionDate: null,
    onDemand,
    stoppedAt: null,
    pauses: [],
  };
}

/**
 * Data access for recording metadata (S5-01, S5-04, S5-05). Every tenant query goes through
 * `scoped(ctx)` (CLAUDE.md rule 2). The two cross-tenant readers, `findByIdForUpload` (the node
 * uploader knows only an opaque recording id) and the retention sweep, use `unscoped(ctx,
 * reason)` and then act on each row through a `scoped` context for that row's own tenant.
 */
export function createRecordingRepo(db: Database<RecordingServiceDb>) {
  return {
    /**
     * Creates the `pending` row at call setup and returns it. The id is random and opaque:
     * it becomes the spool file name and the object key, so it must name nothing.
     */
    async register(ctx: DbContext, input: RegisterRecordingInput): Promise<Recording> {
      return insertRecording(db.scoped(ctx), requireTenant(ctx).tenantId, input);
    },

    /**
     * S5-13: registers an on-demand recording and its audit record in one transaction, so the
     * recording exists (and FreeSWITCH is told to start it) only if the action was audited.
     */
    async startOnDemand(
      ctx: DbContext,
      input: Omit<RegisterRecordingInput, 'onDemand'>,
      audit: AuditEventInput,
    ): Promise<Recording> {
      const { tenantId } = requireTenant(ctx);
      let started: Recording | undefined;
      await db.scoped(ctx).transaction(async (trx, raw) => {
        started = await insertRecording(trx, tenantId, { ...input, onDemand: true });
        await recordAuditEvent(raw, { ...audit, resource: `recording:${started.id}` });
      });
      return started!;
    },

    /**
     * S5-13: marks an on-demand recording stopped, with its audit record, in one transaction.
     * Throws `RecordingStateError` for a recording a rule started, or one already stopped.
     */
    async stopOnDemand(ctx: DbContext, id: string, audit: AuditEventInput): Promise<Recording> {
      let stopped: Recording | undefined;
      await db.scoped(ctx).transaction(async (trx, raw) => {
        const row = await trx
          .selectFrom('recordings')
          .select(COLUMNS)
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) throw new RecordingNotFoundError(`No recording with id '${id}'.`);
        const current = toRecording(row);
        if (!current.onDemand) {
          throw new RecordingStateError(
            'A recording a rule started cannot be stopped by feature code.',
          );
        }
        if (current.stoppedAt !== null) {
          throw new RecordingStateError('That on-demand recording is already stopped.');
        }
        const now = new Date();
        const pauses = closeOpenPause(current.pauses, now);
        await trx
          .updateTable('recordings')
          .set({
            stopped_at: now,
            pause_intervals: serializePauseIntervals(pauses),
            updated_at: now,
          })
          .where('id', '=', id)
          .execute();
        await recordAuditEvent(raw, { ...audit, resource: `recording:${id}` });
        stopped = { ...current, stoppedAt: now, pauses };
      });
      return stopped!;
    },

    /**
     * S5-13: pauses a recording that is running, or resumes one that is paused, with its audit
     * record, in one transaction. `audit(paused)` names the action for the direction taken.
     * Throws `RecordingStateError` for a stopped on-demand recording.
     */
    async togglePause(
      ctx: DbContext,
      id: string,
      audit: (paused: boolean) => AuditEventInput,
    ): Promise<{ recording: Recording; paused: boolean }> {
      let result: { recording: Recording; paused: boolean } | undefined;
      await db.scoped(ctx).transaction(async (trx, raw) => {
        const row = await trx
          .selectFrom('recordings')
          .select(COLUMNS)
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) throw new RecordingNotFoundError(`No recording with id '${id}'.`);
        const current = toRecording(row);
        if (current.stoppedAt !== null) {
          throw new RecordingStateError('That on-demand recording is stopped.');
        }
        const now = new Date();
        const toggled = togglePauseIntervals(current.pauses, now);
        await trx
          .updateTable('recordings')
          .set({ pause_intervals: serializePauseIntervals(toggled.pauses), updated_at: now })
          .where('id', '=', id)
          .execute();
        await recordAuditEvent(raw, { ...audit(toggled.paused), resource: `recording:${id}` });
        result = {
          recording: { ...current, pauses: toggled.pauses },
          paused: toggled.paused,
        };
      });
      return result!;
    },

    findById(ctx: DbContext, id: string): Promise<Recording | undefined> {
      return db
        .scoped(ctx)
        .selectFrom('recordings')
        .select(COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : toRecording(row)));
    },

    /** For the node uploader, which holds only the opaque id from a spool file name. */
    findByIdForUpload(ctx: DbContext, id: string): Promise<Recording | undefined> {
      return db
        .unscoped(ctx, 'node uploader resolving a spool file by its opaque recording id')
        .selectFrom('recordings')
        .select(COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : toRecording(row)));
    },

    async list(
      ctx: DbContext,
      filter: RecordingFilter,
    ): Promise<{ rows: Recording[]; nextCursor: string | null }> {
      const limit = Math.min(
        Math.max(Math.floor(filter.limit ?? DEFAULT_PAGE_SIZE), 1),
        MAX_PAGE_SIZE,
      );
      let query = db.scoped(ctx).selectFrom('recordings').select(COLUMNS);

      if (filter.from !== undefined) query = query.where('started_at', '>=', filter.from);
      if (filter.to !== undefined) query = query.where('started_at', '<', filter.to);
      if (filter.direction !== undefined) query = query.where('direction', '=', filter.direction);
      if (filter.status !== undefined) query = query.where('status', '=', filter.status);
      if (filter.callUuid !== undefined) query = query.where('call_uuid', '=', filter.callUuid);
      if (filter.queueId !== undefined) query = query.where('queue_id', '=', filter.queueId);
      if (filter.didId !== undefined) query = query.where('did_id', '=', filter.didId);
      if (filter.extensionId !== undefined) {
        const extensionId = filter.extensionId;
        query = query.where((eb) =>
          eb.or([eb('extension_id', '=', extensionId), eb('peer_extension_id', '=', extensionId)]),
        );
      }
      if (filter.visibleScopes !== undefined) {
        const scopes = filter.visibleScopes;
        const extensions = scopes.filter((s) => s.type === 'extension').map((s) => s.id);
        const queues = scopes.filter((s) => s.type === 'queue').map((s) => s.id);
        const dids = scopes.filter((s) => s.type === 'did').map((s) => s.id);
        query = query.where((eb) =>
          eb.or([
            ...(extensions.length > 0
              ? [eb('extension_id', 'in', extensions), eb('peer_extension_id', 'in', extensions)]
              : []),
            ...(queues.length > 0 ? [eb('queue_id', 'in', queues)] : []),
            ...(dids.length > 0 ? [eb('did_id', 'in', dids)] : []),
            // A scoped viewer with no usable scope sees nothing.
            ...(scopes.length === 0 ? [eb.val(false)] : []),
          ]),
        );
      }
      if (filter.cursor !== undefined) {
        const { startedAt, id } = decodeCursor(filter.cursor);
        query = query.where((eb) =>
          eb.or([
            eb('started_at', '<', startedAt),
            eb.and([eb('started_at', '=', startedAt), eb('id', '<', id)]),
          ]),
        );
      }

      const rows = await query
        .orderBy('started_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1)
        .execute();
      const page = rows.slice(0, limit).map(toRecording);
      const last = page[page.length - 1];
      return {
        rows: page,
        nextCursor:
          rows.length > limit && last !== undefined ? encodeCursor(last.startedAt, last.id) : null,
      };
    },

    /**
     * Marks a pending recording ready after the uploader's upload was verified, and stamps
     * its retention date. Emits `recording.recording.ready`. Completing a recording that is
     * already ready returns it unchanged (a retried request).
     */
    async complete(ctx: DbContext, id: string, input: CompleteRecordingInput): Promise<Recording> {
      const { tenantId } = requireTenant(ctx);
      let result: Recording | undefined;
      await db.scoped(ctx).transaction(async (trx, raw) => {
        const existing = await trx
          .selectFrom('recordings')
          .select(COLUMNS)
          .where('id', '=', id)
          .executeTakeFirst();
        if (existing === undefined)
          throw new RecordingNotFoundError(`No recording with id '${id}'.`);
        if (existing.status === 'ready') {
          result = toRecording(existing);
          return;
        }
        if (existing.status !== 'pending' && existing.status !== 'failed') {
          throw new RecordingStateError(`A ${existing.status} recording cannot be completed.`);
        }
        const retentionDate = retentionDateFor(existing.startedAt, input.retentionDays);
        await trx
          .updateTable('recordings')
          .set({
            status: 'ready',
            size_bytes: input.sizeBytes,
            duration_ms: input.durationMs,
            sha256: input.sha256,
            failure_reason: null,
            retention_date: retentionDate,
            updated_at: new Date(),
          })
          .where('id', '=', id)
          .execute();
        await enqueueEvent(raw, recordingEvents, {
          type: 'recording.recording.ready',
          data: { recordingId: id },
          orgContext: { tenantId },
        });
        result = toRecording({
          ...existing,
          status: 'ready',
          sizeBytes: input.sizeBytes,
          durationMs: input.durationMs,
          sha256: input.sha256,
          failureReason: null,
          retentionDate,
        });
      });
      return result!;
    },

    async fail(ctx: DbContext, id: string, reason: string): Promise<void> {
      const result = await db
        .scoped(ctx)
        .updateTable('recordings')
        .set({ status: 'failed', failure_reason: reason.slice(0, 128), updated_at: new Date() })
        .where('id', '=', id)
        .where('status', 'in', ['pending', 'failed'])
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        const exists = await this.findById(ctx, id);
        if (exists === undefined) throw new RecordingNotFoundError(`No recording with id '${id}'.`);
      }
    },

    /** Deletes the row, the `recording.recording.deleted` event and its audit record in one transaction. */
    async remove(ctx: DbContext, id: string, audit?: AuditEventInput): Promise<void> {
      const { tenantId } = requireTenant(ctx);
      await db.scoped(ctx).transaction(async (trx, raw) => {
        const result = await trx.deleteFrom('recordings').where('id', '=', id).executeTakeFirst();
        if (Number(result.numDeletedRows) === 0) {
          throw new RecordingNotFoundError(`No recording with id '${id}'.`);
        }
        await enqueueEvent(raw, recordingEvents, {
          type: 'recording.recording.deleted',
          data: { recordingId: id },
          orgContext: { tenantId },
        });
        if (audit !== undefined)
          await recordAuditEvent(raw, { ...audit, resource: `recording:${id}` });
      });
    },

    /** Ready recordings whose retention date has passed, across tenants, oldest first. Background job only. */
    async findDueForExpiry(
      ctx: DbContext,
      now: Date,
      limit: number,
    ): Promise<Pick<Recording, 'id' | 'tenantId' | 'objectKey'>[]> {
      return db
        .unscoped(ctx, 'retention sweep: recordings past their retention date')
        .selectFrom('recordings')
        .select(['id', 'tenant_id as tenantId', 'object_key as objectKey'])
        .where('status', '=', 'ready')
        .where('retention_date', 'is not', null)
        .where('retention_date', '<=', now)
        .orderBy('retention_date', 'asc')
        .limit(limit)
        .execute();
    },

    /** Marks a recording expired after its audio was deleted, keeping the metadata row. */
    async markExpired(ctx: DbContext, id: string): Promise<void> {
      const { tenantId } = requireTenant(ctx);
      await db.scoped(ctx).transaction(async (trx, raw) => {
        const result = await trx
          .updateTable('recordings')
          .set({ status: 'expired', updated_at: new Date() })
          .where('id', '=', id)
          .where('status', '=', 'ready')
          .executeTakeFirst();
        if (Number(result.numUpdatedRows) === 0) return;
        await enqueueEvent(raw, recordingEvents, {
          type: 'recording.recording.expired',
          data: { recordingId: id },
          orgContext: { tenantId },
        });
      });
    },

    /** Pending recordings registered before `cutoff` that never arrived: marks them failed. Returns how many. Background job only. */
    async failStalePending(ctx: DbContext, cutoff: Date): Promise<number> {
      const result = await db
        .unscoped(ctx, 'retention sweep: recordings registered but never uploaded')
        .updateTable('recordings')
        .set({ status: 'failed', failure_reason: 'never_uploaded', updated_at: new Date() })
        .where('status', '=', 'pending')
        .where('created_at', '<', cutoff)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },
  };
}

export type RecordingRepo = ReturnType<typeof createRecordingRepo>;
