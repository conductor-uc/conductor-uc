import { randomUUID } from 'node:crypto';

import type { Database } from '@cuc/db';

import type { IdentityServiceDb } from '../schema.js';

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
  };
}

export type MfaRepo = ReturnType<typeof createMfaRepo>;
