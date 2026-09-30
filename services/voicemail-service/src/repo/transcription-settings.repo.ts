import type { Database, DbContext } from '@cuc/db';
import { requireTenant } from '@cuc/db';

import {
  InvalidTranscriptionSettingsError,
  isEngine,
  TENANT_DEFAULT,
  type TenantTranscription,
} from '../domain/transcription.js';
import type { VoicemailServiceDb } from '../schema.js';

/**
 * S5-06 (O-3): each tenant's transcription opt-in: whether its mailboxes are transcribed (those
 * that follow the tenant) and by which engine. No row means off. Every query goes through
 * `scoped(ctx)` (CLAUDE.md rule 2).
 */
export function createTranscriptionSettingsRepo(db: Database<VoicemailServiceDb>) {
  return {
    async get(ctx: DbContext): Promise<TenantTranscription> {
      const row = await db
        .scoped(ctx)
        .selectFrom('transcription_settings')
        .select(['enabled', 'engine'])
        .executeTakeFirst();
      if (row === undefined) return TENANT_DEFAULT;
      return {
        enabled: Boolean(row.enabled),
        engine: isEngine(row.engine) ? row.engine : 'default',
      };
    },

    async put(
      ctx: DbContext,
      input: { readonly enabled: boolean; readonly engine: string },
    ): Promise<TenantTranscription> {
      requireTenant(ctx);
      if (!isEngine(input.engine)) {
        throw new InvalidTranscriptionSettingsError(
          `'${input.engine}' is not a transcription engine.`,
        );
      }
      const now = new Date();
      const existing = await db
        .scoped(ctx)
        .selectFrom('transcription_settings')
        .select('version')
        .executeTakeFirst();
      if (existing === undefined) {
        await db
          .scoped(ctx)
          .insertInto('transcription_settings')
          .values({ enabled: input.enabled, engine: input.engine, updated_at: now, version: 1 })
          .execute();
      } else {
        await db
          .scoped(ctx)
          .updateTable('transcription_settings')
          .set({
            enabled: input.enabled,
            engine: input.engine,
            updated_at: now,
            version: existing.version + 1,
          })
          .execute();
      }
      return { enabled: input.enabled, engine: input.engine };
    },
  };
}

export type TranscriptionSettingsRepo = ReturnType<typeof createTranscriptionSettingsRepo>;
