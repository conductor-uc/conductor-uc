import { recordAuditEvent } from '@cuc/audit';
import type { Database, DbContext } from '@cuc/db';

import type { IdentityServiceDb } from '../schema.js';

/** The platform's sign-in policy (D-012 as amended 2026-09-28). */
export interface SecuritySettings {
  /**
   * Whether the master org's users must set up two-step verification at sign-in.
   * Off on a fresh install, so the platform can be configured first; reseller
   * users must enrol whatever this says.
   */
  readonly requireMasterMfa: boolean;
  readonly updatedBy: string | null;
  readonly updatedAt: Date | null;
}

const ROW_ID = 1;

const DEFAULTS: SecuritySettings = { requireMasterMfa: false, updatedBy: null, updatedAt: null };

export function createSecuritySettingsRepo(db: Database<IdentityServiceDb>) {
  const kysely = db.kysely;

  return {
    async get(): Promise<SecuritySettings> {
      const row = await kysely
        .selectFrom('platform_security_settings')
        .selectAll()
        .where('id', '=', ROW_ID)
        .executeTakeFirst();
      if (row === undefined) return DEFAULTS;
      return {
        requireMasterMfa: Boolean(row.require_master_mfa),
        updatedBy: row.updated_by,
        updatedAt: row.updated_at,
      };
    },

    /** Saves the policy and records who changed it in the audit trail, in one transaction. */
    async save(
      ctx: DbContext & { readonly actorId: string; readonly orgId: string },
      input: { readonly requireMasterMfa: boolean },
      now: Date = new Date(),
    ): Promise<SecuritySettings> {
      return kysely.transaction().execute(async (trx) => {
        const values = {
          id: ROW_ID,
          require_master_mfa: input.requireMasterMfa,
          updated_by: ctx.actorId,
          updated_at: now,
        };
        await trx
          .insertInto('platform_security_settings')
          .values(values)
          .onDuplicateKeyUpdate({
            require_master_mfa: values.require_master_mfa,
            updated_by: values.updated_by,
            updated_at: values.updated_at,
          })
          .execute();
        await recordAuditEvent(trx, {
          actorType: 'user',
          actorId: ctx.actorId,
          actorOrgId: ctx.orgId,
          targetOrgId: ctx.orgId,
          action: 'platform.security_settings.updated',
          resource: input.requireMasterMfa ? 'require_master_mfa:on' : 'require_master_mfa:off',
          dataClass: 'config',
          ...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId }),
        });
        return { requireMasterMfa: input.requireMasterMfa, updatedBy: ctx.actorId, updatedAt: now };
      });
    },
  };
}

export type SecuritySettingsRepo = ReturnType<typeof createSecuritySettingsRepo>;
