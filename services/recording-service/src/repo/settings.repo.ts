import { recordAuditEvent, type AuditEventInput } from '@cuc/audit';
import { requireTenant, type Database, type DbContext } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import { validateRetentionDays } from '../domain/retention.js';
import { recordingEvents } from '../events.js';
import type { RecordingServiceDb } from '../schema.js';

/**
 * Per-tenant recording settings: the retention period (S5-05). A tenant with no row uses
 * the deployment default (`RECORDING_DEFAULT_RETENTION_DAYS`).
 */
export function createSettingsRepo(db: Database<RecordingServiceDb>, defaultRetentionDays: number) {
  async function retentionDays(ctx: DbContext): Promise<number> {
    const row = await db
      .scoped(ctx)
      .selectFrom('recording_settings')
      .select('retention_days as retentionDays')
      .executeTakeFirst();
    return row?.retentionDays ?? defaultRetentionDays;
  }

  return {
    retentionDays,

    /**
     * Stores the period and moves the retention date of every recording that is still
     * ready to `started + days` (or clears it when retention is off), so shortening it
     * takes effect on recordings already made.
     */
    async setRetentionDays(ctx: DbContext, days: number, audit?: AuditEventInput): Promise<number> {
      const { tenantId } = requireTenant(ctx);
      const valid = validateRetentionDays(days);
      const now = new Date();

      await db.scoped(ctx).transaction(async (trx, raw) => {
        const existing = await trx
          .selectFrom('recording_settings')
          .select('version')
          .executeTakeFirst();
        if (existing === undefined) {
          await trx
            .insertInto('recording_settings')
            .values({ retention_days: valid, updated_at: now, version: 1 })
            .execute();
        } else {
          await trx
            .updateTable('recording_settings')
            .set({ retention_days: valid, updated_at: now, version: existing.version + 1 })
            .execute();
        }

        await trx
          .updateTable('recordings')
          .set((eb) => ({
            // ADDDATE(date, n) adds n days.
            retention_date:
              valid === 0 ? null : eb.fn<Date>('ADDDATE', [eb.ref('started_at'), eb.val(valid)]),
            updated_at: now,
          }))
          .where('status', '=', 'ready')
          .execute();

        await enqueueEvent(raw, recordingEvents, {
          type: 'recording.retention.updated',
          data: { retentionDays: valid },
          orgContext: { tenantId },
        });
        if (audit !== undefined) {
          await recordAuditEvent(raw, { ...audit, resource: `recording-settings:${tenantId}` });
        }
      });
      return valid;
    },
  };
}

export type SettingsRepo = ReturnType<typeof createSettingsRepo>;
