import { randomUUID } from 'node:crypto';

import { recordAuditEvent, type AuditEventInput } from '@cuc/audit';
import { isDuplicateKeyError, requireTenant, type Database, type DbContext } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import type {
  Policy,
  PolicyAction,
  PolicyDirection,
  PolicyScopeType,
  ValidPolicy,
} from '../domain/policy.js';
import { recordingEvents } from '../events.js';
import type { RecordingServiceDb } from '../schema.js';

export class PolicyNotFoundError extends Error {
  override readonly name = 'PolicyNotFoundError';
}

export class PolicyConflictError extends Error {
  override readonly name = 'PolicyConflictError';
}

const COLUMNS = [
  'id',
  'scope_type as scopeType',
  'scope_id as scopeId',
  'direction',
  'action',
  'announce',
  'consent_asset_id as consentAssetId',
] as const;

function toPolicy(row: {
  id: string;
  scopeType: string;
  scopeId: string;
  direction: string;
  action: string;
  announce: boolean | number;
  consentAssetId: string | null;
}): Policy {
  return {
    id: row.id,
    scopeType: row.scopeType as PolicyScopeType,
    scopeId: row.scopeId,
    direction: row.direction as PolicyDirection,
    action: row.action as PolicyAction,
    announce: Boolean(row.announce),
    consentAssetId: row.consentAssetId,
  };
}

/**
 * Data access for recording policies (S5-01). Every query goes through `scoped(ctx)`
 * (CLAUDE.md rule 2). Each write enqueues its `recording.policy.*` event, and the audit
 * record when the caller passes one, in the same transaction (rule 6).
 */
export function createPolicyRepo(db: Database<RecordingServiceDb>) {
  return {
    list(ctx: DbContext): Promise<Policy[]> {
      return db
        .scoped(ctx)
        .selectFrom('recording_policies')
        .select(COLUMNS)
        .orderBy('created_at', 'asc')
        .orderBy('id', 'asc')
        .execute()
        .then((rows) => rows.map(toPolicy));
    },

    findById(ctx: DbContext, id: string): Promise<Policy | undefined> {
      return db
        .scoped(ctx)
        .selectFrom('recording_policies')
        .select(COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : toPolicy(row)));
    },

    async create(ctx: DbContext, input: ValidPolicy, audit?: AuditEventInput): Promise<Policy> {
      const { tenantId } = requireTenant(ctx);
      const id = randomUUID();
      const now = new Date();
      try {
        await db.scoped(ctx).transaction(async (trx, raw) => {
          await trx
            .insertInto('recording_policies')
            .values({
              id,
              scope_type: input.scopeType,
              scope_id: input.scopeId,
              direction: input.direction,
              action: input.action,
              announce: input.announce,
              consent_asset_id: input.consentAssetId,
              created_at: now,
              updated_at: now,
              version: 1,
            })
            .execute();
          await enqueueEvent(raw, recordingEvents, {
            type: 'recording.policy.created',
            data: { policyId: id },
            orgContext: { tenantId },
          });
          if (audit !== undefined)
            await recordAuditEvent(raw, { ...audit, resource: `recording-policy:${id}` });
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new PolicyConflictError(
            'A policy for that scope and direction already exists; change it instead.',
          );
        }
        throw error;
      }
      return { id, ...input };
    },

    async update(
      ctx: DbContext,
      id: string,
      input: ValidPolicy,
      audit?: AuditEventInput,
    ): Promise<Policy> {
      const { tenantId } = requireTenant(ctx);
      try {
        await db.scoped(ctx).transaction(async (trx, raw) => {
          const result = await trx
            .updateTable('recording_policies')
            .set({
              scope_type: input.scopeType,
              scope_id: input.scopeId,
              direction: input.direction,
              action: input.action,
              announce: input.announce,
              consent_asset_id: input.consentAssetId,
              updated_at: new Date(),
            })
            .where('id', '=', id)
            .executeTakeFirst();
          if (Number(result.numUpdatedRows) === 0) {
            // MariaDB reports 0 changed rows for a no-op update, so confirm it exists.
            const exists = await trx
              .selectFrom('recording_policies')
              .select('id')
              .where('id', '=', id)
              .executeTakeFirst();
            if (exists === undefined) throw new PolicyNotFoundError(`No policy with id '${id}'.`);
          }
          await enqueueEvent(raw, recordingEvents, {
            type: 'recording.policy.updated',
            data: { policyId: id },
            orgContext: { tenantId },
          });
          if (audit !== undefined)
            await recordAuditEvent(raw, { ...audit, resource: `recording-policy:${id}` });
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new PolicyConflictError(
            'A policy for that scope and direction already exists; change it instead.',
          );
        }
        throw error;
      }
      return { id, ...input };
    },

    async remove(ctx: DbContext, id: string, audit?: AuditEventInput): Promise<void> {
      const { tenantId } = requireTenant(ctx);
      await db.scoped(ctx).transaction(async (trx, raw) => {
        const result = await trx
          .deleteFrom('recording_policies')
          .where('id', '=', id)
          .executeTakeFirst();
        if (Number(result.numDeletedRows) === 0) {
          throw new PolicyNotFoundError(`No policy with id '${id}'.`);
        }
        await enqueueEvent(raw, recordingEvents, {
          type: 'recording.policy.deleted',
          data: { policyId: id },
          orgContext: { tenantId },
        });
        if (audit !== undefined)
          await recordAuditEvent(raw, { ...audit, resource: `recording-policy:${id}` });
      });
    },
  };
}

export type PolicyRepo = ReturnType<typeof createPolicyRepo>;
