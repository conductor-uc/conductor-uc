import { recordAuditEvent, type AuditEventInput } from '@cuc/audit';
import { requireTenant, type Database, type DbContext } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import { validateRetentionDays } from '../domain/retention.js';
import { recordingEvents } from '../events.js';
import type { RecordingServiceDb } from '../schema.js';

/** A tenant's recording settings. */
export interface RecordingSettings {
  /** 0 keeps recordings until deleted. */
  readonly retentionDays: number;
  /** S5-12: refuse a call when its recording cannot be set up. */
  readonly failClosed: boolean;
}

/** A change to some of a tenant's settings; what is left out keeps its value. */
export interface RecordingSettingsChange {
  readonly retentionDays?: number | undefined;
  readonly failClosed?: boolean | undefined;
}

/**
 * Per-tenant recording settings: the retention period (S5-05) and whether recording is required
 * (S5-12, fail closed). A tenant with no row uses the deployment default retention
 * (`RECORDING_DEFAULT_RETENTION_DAYS`) and fails open.
 *
 * Every write emits `recording.settings.updated` carrying both values, so telephony-config can keep
 * its own copy of the fail-closed flag and use it while this service is unreachable (G-111).
 */
export function createSettingsRepo(db: Database<RecordingServiceDb>, defaultRetentionDays: number) {
  async function settings(ctx: DbContext): Promise<RecordingSettings> {
    const row = await db
      .scoped(ctx)
      .selectFrom('recording_settings')
      .select(['retention_days as retentionDays', 'fail_closed as failClosed'])
      .executeTakeFirst();
    return {
      retentionDays: row?.retentionDays ?? defaultRetentionDays,
      failClosed: Boolean(row?.failClosed ?? false),
    };
  }

  /**
   * Applies `change` and returns the settings after it. A new retention period also moves the
   * retention date of every recording that is still ready to `started + days` (or clears it when
   * retention is off), so shortening it takes effect on recordings already made.
   */
  async function update(
    ctx: DbContext,
    change: RecordingSettingsChange,
    audit?: AuditEventInput,
  ): Promise<RecordingSettings> {
    const { tenantId } = requireTenant(ctx);
    const retention =
      change.retentionDays === undefined ? undefined : validateRetentionDays(change.retentionDays);
    const now = new Date();
    let result: RecordingSettings | undefined;

    await db.scoped(ctx).transaction(async (trx, raw) => {
      const existing = await trx
        .selectFrom('recording_settings')
        .select(['version', 'retention_days as retentionDays', 'fail_closed as failClosed'])
        .executeTakeFirst();
      const next: RecordingSettings = {
        retentionDays: retention ?? existing?.retentionDays ?? defaultRetentionDays,
        failClosed: change.failClosed ?? Boolean(existing?.failClosed ?? false),
      };

      if (existing === undefined) {
        await trx
          .insertInto('recording_settings')
          .values({
            retention_days: next.retentionDays,
            fail_closed: next.failClosed,
            updated_at: now,
            version: 1,
          })
          .execute();
      } else {
        await trx
          .updateTable('recording_settings')
          .set({
            retention_days: next.retentionDays,
            fail_closed: next.failClosed,
            updated_at: now,
            version: existing.version + 1,
          })
          .execute();
      }

      if (retention !== undefined) {
        await trx
          .updateTable('recordings')
          .set((eb) => ({
            // ADDDATE(date, n) adds n days.
            retention_date:
              retention === 0
                ? null
                : eb.fn<Date>('ADDDATE', [eb.ref('started_at'), eb.val(retention)]),
            updated_at: now,
          }))
          .where('status', '=', 'ready')
          .execute();

        await enqueueEvent(raw, recordingEvents, {
          type: 'recording.retention.updated',
          data: { retentionDays: retention },
          orgContext: { tenantId },
        });
      }

      await enqueueEvent(raw, recordingEvents, {
        type: 'recording.settings.updated',
        data: { retentionDays: next.retentionDays, failClosed: next.failClosed },
        orgContext: { tenantId },
      });
      if (audit !== undefined) {
        await recordAuditEvent(raw, { ...audit, resource: `recording-settings:${tenantId}` });
      }
      result = next;
    });
    return result!;
  }

  return {
    settings,
    update,

    async retentionDays(ctx: DbContext): Promise<number> {
      return (await settings(ctx)).retentionDays;
    },

    /** Stores the retention period; see `update`. */
    async setRetentionDays(ctx: DbContext, days: number, audit?: AuditEventInput): Promise<number> {
      return (await update(ctx, { retentionDays: days }, audit)).retentionDays;
    },

    /**
     * Every tenant that requires recording, for telephony-config's reconciliation (S5-12): it
     * repairs its own copy of the flag from this list if an event was missed.
     */
    async listFailClosedTenantIds(ctx: DbContext): Promise<string[]> {
      const rows = await db
        .unscoped(ctx, 'telephony-config reconciling its copy of the fail-closed recording flag')
        .selectFrom('recording_settings')
        .select('tenant_id as tenantId')
        .where('fail_closed', '=', true)
        .orderBy('tenant_id')
        .execute();
      return rows.map((row) => row.tenantId);
    },
  };
}

export type SettingsRepo = ReturnType<typeof createSettingsRepo>;
