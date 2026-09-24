import { randomUUID } from 'node:crypto';

import { recordAuditEvent } from '@cuc/audit';
import type { Database, DbContext } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import { identityEvents } from '../events.js';
import type { IdentityServiceDb } from '../schema.js';

/** The result of an admin resetting a user's two-step verification. */
export type MfaResetResult =
  | { readonly outcome: 'reset' }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'not_enrolled' };

export interface MfaFactor {
  readonly id: string;
  readonly userId: string;
  readonly secretEnc: string;
  readonly confirmed: boolean;
}

/**
 * Data access for TOTP factors, and for the `users.mfa_enrolled` flag that is
 * denormalized from them.
 *
 * `confirm()` updates both `mfa_factors.confirmed_at` and `users.mfa_enrolled`
 * in one transaction — the two must never disagree, so they are written
 * together rather than through two separately-scoped repositories.
 */
export function createMfaRepo(db: Database<IdentityServiceDb>) {
  const mfa = db.kysely;

  function toFactor(row: {
    id: string;
    user_id: string;
    secret_enc: string;
    confirmed_at: Date | null;
  }): MfaFactor {
    return {
      id: row.id,
      userId: row.user_id,
      secretEnc: row.secret_enc,
      confirmed: row.confirmed_at !== null,
    };
  }

  return {
    /** Starts enrollment: an unconfirmed factor authenticates nobody. */
    createPending: async (userId: string, secretEnc: string): Promise<MfaFactor> => {
      const id = randomUUID();
      await mfa
        .insertInto('mfa_factors')
        .values({
          id,
          user_id: userId,
          type: 'totp',
          secret_enc: secretEnc,
          confirmed_at: null,
          created_at: new Date(),
        })
        .execute();
      return { id, userId, secretEnc, confirmed: false };
    },

    findById: async (id: string): Promise<MfaFactor | undefined> => {
      const row = await mfa
        .selectFrom('mfa_factors')
        .select(['id', 'user_id', 'secret_enc', 'confirmed_at'])
        .where('id', '=', id)
        .executeTakeFirst();
      return row === undefined ? undefined : toFactor(row);
    },

    /** The one confirmed factor for a user, if any — what login checks a code against. */
    findConfirmedByUser: async (userId: string): Promise<MfaFactor | undefined> => {
      const row = await mfa
        .selectFrom('mfa_factors')
        .select(['id', 'user_id', 'secret_enc', 'confirmed_at'])
        .where('user_id', '=', userId)
        .where('confirmed_at', 'is not', null)
        .executeTakeFirst();
      return row === undefined ? undefined : toFactor(row);
    },

    /**
     * Confirms a factor and flips `users.mfa_enrolled`, together. Returns
     * false rather than throwing when the factor does not exist, belongs to a
     * different user, or is already confirmed — the caller (the enrollment
     * endpoint) turns that into a 401, since replaying an enrollment ticket
     * against an already-confirmed factor is exactly what a stolen ticket
     * would try.
     */
    async confirm(userId: string, factorId: string): Promise<boolean> {
      return db.kysely.transaction().execute(async (trx) => {
        const result = await trx
          .updateTable('mfa_factors')
          .set({ confirmed_at: new Date() })
          .where('id', '=', factorId)
          .where('user_id', '=', userId)
          .where('confirmed_at', 'is', null)
          .executeTakeFirst();

        if (Number(result.numUpdatedRows) === 0) return false;

        await trx
          .updateTable('users')
          .set({ mfa_enrolled: true, updated_at: new Date() })
          .where('id', '=', userId)
          .execute();
        return true;
      });
    },

    /**
     * An admin removes a user's authenticator (a lost phone). In one
     * transaction: every factor is deleted, `mfa_enrolled` goes false, every
     * session is revoked, and the reset is recorded twice, as the
     * `identity.user.mfa_reset` event notification-service turns into an email
     * and as an audit event (07 §4: all writes). At the next sign-in the
     * user is asked to enroll a new authenticator, exactly as a first login.
     *
     * Nothing to reset for a user who never enrolled, so that is reported
     * rather than recorded as a change.
     */
    async reset(
      ctx: DbContext & { readonly actorId: string; readonly orgId: string },
      orgId: string,
      userId: string,
    ): Promise<MfaResetResult> {
      return db.kysely.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('users')
          .select(['email', 'display_name', 'mfa_enrolled', 'version'])
          .where('id', '=', userId)
          .where('org_id', '=', orgId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return { outcome: 'not_found' as const };
        if (!row.mfa_enrolled) return { outcome: 'not_enrolled' as const };

        const now = new Date();
        await trx.deleteFrom('mfa_factors').where('user_id', '=', userId).execute();
        await trx
          .updateTable('users')
          .set({ mfa_enrolled: false, updated_at: now, version: row.version + 1 })
          .where('id', '=', userId)
          .execute();
        await trx
          .updateTable('sessions')
          .set({ revoked_at: now })
          .where('user_id', '=', userId)
          .where('revoked_at', 'is', null)
          .execute();

        await enqueueEvent(trx, identityEvents, {
          type: 'identity.user.mfa_reset',
          data: { userId, orgId, email: row.email, displayName: row.display_name },
          actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId },
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
        await recordAuditEvent(trx, {
          actorType: 'user',
          actorId: ctx.actorId,
          actorOrgId: ctx.orgId,
          targetOrgId: orgId,
          action: 'user.mfa_reset',
          resource: `user:${userId}`,
          dataClass: 'config',
          ...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId }),
        });
        return { outcome: 'reset' as const };
      });
    },
  };
}

export type MfaRepo = ReturnType<typeof createMfaRepo>;
