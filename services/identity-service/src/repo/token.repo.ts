import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import { normalizeEmail } from '../domain/email.js';
import { identityEvents } from '../events.js';
import type { IdentityServiceDb, UserOrgType } from '../schema.js';
import type { User } from './user.repo.js';

export interface Invitation {
  readonly id: string;
  readonly orgId: string;
  readonly orgType: UserOrgType;
  readonly resellerId: string | null;
  readonly email: string;
  readonly displayName: string;
  readonly expiresAt: Date;
}

export class InvitationConflictError extends Error {
  override readonly name = 'InvitationConflictError';

  constructor() {
    super('That email already has an open invitation to this org.');
  }
}

/**
 * Password-reset and invitation tokens. A token is 256 random bits and only
 * its SHA-256 is stored. Each is single-use: consuming one is an atomic
 * `UPDATE … WHERE used_at IS NULL AND expires_at > now`, so two concurrent
 * requests cannot both succeed.
 */
export function createTokenRepo(db: Database<IdentityServiceDb>) {
  return {
    /**
     * Records a reset token for [user] and publishes the event that carries it
     * to the mailer, in one transaction: a token that was never announced
     * would be unreachable, an announced one that was never stored useless.
     */
    async createPasswordReset(
      ctx: DbContext,
      user: User,
      ttlMinutes: number,
    ): Promise<{ token: string; expiresAt: Date }> {
      const token = newToken();
      const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
      await db.kysely.transaction().execute(async (trx) => {
        await trx
          .insertInto('password_reset_tokens')
          .values({
            id: randomUUID(),
            user_id: user.id,
            token_hash: hashToken(token),
            expires_at: expiresAt,
            used_at: null,
            created_at: new Date(),
          })
          .execute();
        await enqueueEvent(trx, identityEvents, {
          type: 'identity.user.password_reset_requested',
          data: {
            userId: user.id,
            orgId: user.orgId,
            email: user.email,
            token,
            expiresAt: expiresAt.toISOString(),
          },
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });
      return { token, expiresAt };
    },

    /** The user a valid, unused, unexpired reset token belongs to; marks it used. */
    async consumePasswordReset(token: string): Promise<string | undefined> {
      return db.kysely.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('password_reset_tokens')
          .select(['id', 'user_id'])
          .where('token_hash', '=', hashToken(token))
          .where('used_at', 'is', null)
          .where('expires_at', '>', new Date())
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return undefined;
        await trx
          .updateTable('password_reset_tokens')
          .set({ used_at: new Date() })
          .where('id', '=', row.id)
          .execute();
        return row.user_id;
      });
    },

    async createInvitation(
      ctx: DbContext,
      input: {
        orgId: string;
        orgType: UserOrgType;
        resellerId: string | null;
        email: string;
        displayName: string;
        invitedBy: string | null;
      },
      ttlDays: number,
    ): Promise<{ id: string; token: string; expiresAt: Date; email: string }> {
      const token = newToken();
      const id = randomUUID();
      const email = normalizeEmail(input.email);
      const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60_000);
      await db.kysely.transaction().execute(async (trx) => {
        const open = await trx
          .selectFrom('invitations')
          .select('id')
          .where('org_id', '=', input.orgId)
          .where('email', '=', email)
          .where('accepted_at', 'is', null)
          .where('expires_at', '>', new Date())
          .executeTakeFirst();
        if (open !== undefined) throw new InvitationConflictError();

        await trx
          .insertInto('invitations')
          .values({
            id,
            org_id: input.orgId,
            org_type: input.orgType,
            reseller_id: input.resellerId,
            email,
            display_name: input.displayName,
            invited_by: input.invitedBy,
            token_hash: hashToken(token),
            expires_at: expiresAt,
            accepted_at: null,
            created_at: new Date(),
          })
          .execute();
        await enqueueEvent(trx, identityEvents, {
          type: 'identity.invitation.created',
          data: {
            invitationId: id,
            orgId: input.orgId,
            orgType: input.orgType,
            resellerId: input.resellerId,
            email,
            displayName: input.displayName,
            token,
            expiresAt: expiresAt.toISOString(),
          },
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });
      return { id, token, expiresAt, email };
    },

    /** An open invitation for [token], without consuming it. */
    async findOpenInvitation(token: string): Promise<Invitation | undefined> {
      const row = await db.kysely
        .selectFrom('invitations')
        .selectAll()
        .where('token_hash', '=', hashToken(token))
        .where('accepted_at', 'is', null)
        .where('expires_at', '>', new Date())
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : {
            id: row.id,
            orgId: row.org_id,
            orgType: row.org_type,
            resellerId: row.reseller_id,
            email: row.email,
            displayName: row.display_name,
            expiresAt: row.expires_at,
          };
    },

    /** Marks an invitation accepted; false if it was already taken or has expired. */
    async markInvitationAccepted(id: string): Promise<boolean> {
      const result = await db.kysely
        .updateTable('invitations')
        .set({ accepted_at: new Date() })
        .where('id', '=', id)
        .where('accepted_at', 'is', null)
        .where('expires_at', '>', new Date())
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },
  };
}

export type TokenRepo = ReturnType<typeof createTokenRepo>;

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
