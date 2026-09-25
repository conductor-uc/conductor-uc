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
 * What issuing a reset or invitation link came to. Only `issued` carries a
 * token; every other outcome means no email should go out.
 */
export type LinkIssue =
  | { readonly status: 'issued'; readonly token: string; readonly expiresAt: Date }
  | { readonly status: 'not_found' | 'used' | 'expired' | 'user_inactive' };

/**
 * Password-reset and invitation tokens. A token is 256 random bits and only
 * its SHA-256 is stored. Each is single-use: consuming one is an atomic
 * `UPDATE … WHERE used_at IS NULL AND expires_at > now`, so two concurrent
 * requests cannot both succeed.
 *
 * A reset request or invitation is created without a token; the token is
 * issued when notification-service sends the email (G-55), and issuing again
 * replaces it. A row whose link was never issued has a NULL hash, which no
 * presented token can match.
 */
export function createTokenRepo(db: Database<IdentityServiceDb>) {
  return {
    /**
     * Records a reset request for [user] and publishes the event that asks for
     * the email, in one transaction. No token exists yet: it is issued when the
     * email is sent ({@link issuePasswordResetLink}), so neither the outbox row
     * nor the stream ever holds one (G-55). The request expires [ttlMinutes]
     * from now whenever the link is issued.
     */
    async createPasswordReset(
      ctx: DbContext,
      user: User,
      ttlMinutes: number,
    ): Promise<{ id: string; expiresAt: Date }> {
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
      await db.kysely.transaction().execute(async (trx) => {
        await trx
          .insertInto('password_reset_tokens')
          .values({
            id,
            user_id: user.id,
            token_hash: null,
            expires_at: expiresAt,
            used_at: null,
            created_at: new Date(),
          })
          .execute();
        await enqueueEvent(trx, identityEvents, {
          type: 'identity.user.password_reset_requested',
          data: {
            resetId: id,
            userId: user.id,
            orgId: user.orgId,
            email: user.email,
            expiresAt: expiresAt.toISOString(),
          },
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });
      return { id, expiresAt };
    },

    /**
     * Issues the link for reset request [resetId] of a user in [orgId]: a new
     * token whose hash replaces any earlier one, so a token issued before (for
     * an email that was retried) stops working. The raw token is returned
     * once and stored nowhere. Refused when the request is unknown, used or
     * expired, or its user is no longer active.
     */
    async issuePasswordResetLink(orgId: string, resetId: string): Promise<LinkIssue> {
      return db.kysely.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('password_reset_tokens as r')
          .innerJoin('users as u', 'u.id', 'r.user_id')
          .select(['r.id', 'r.expires_at', 'r.used_at', 'u.org_id', 'u.status'])
          .where('r.id', '=', resetId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined || row.org_id !== orgId) return { status: 'not_found' };
        if (row.used_at !== null) return { status: 'used' };
        if (row.expires_at.getTime() <= Date.now()) return { status: 'expired' };
        if (row.status !== 'active') return { status: 'user_inactive' };

        const token = newToken();
        await trx
          .updateTable('password_reset_tokens')
          .set({ token_hash: hashToken(token) })
          .where('id', '=', row.id)
          .execute();
        return { status: 'issued', token, expiresAt: row.expires_at };
      });
    },

    /** The user a valid, unused, unexpired reset token belongs to, without using it. */
    async findOpenPasswordReset(token: string): Promise<string | undefined> {
      const row = await db.kysely
        .selectFrom('password_reset_tokens')
        .select('user_id')
        .where('token_hash', '=', hashToken(token))
        .where('used_at', 'is', null)
        .where('expires_at', '>', new Date())
        .executeTakeFirst();
      return row?.user_id;
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
      ttlHours: number,
    ): Promise<{ id: string; expiresAt: Date; email: string }> {
      const id = randomUUID();
      const email = normalizeEmail(input.email);
      const expiresAt = new Date(Date.now() + ttlHours * 60 * 60_000);
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
            // Issued when the email is sent (G-55).
            token_hash: null,
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
            expiresAt: expiresAt.toISOString(),
          },
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });
      return { id, expiresAt, email };
    },

    /**
     * Issues the link for invitation [invitationId] into [orgId], exactly as
     * {@link issuePasswordResetLink} does for a reset: a fresh token whose hash
     * replaces any earlier one, returned once. Refused when the invitation is
     * unknown, already accepted or expired.
     */
    async issueInvitationLink(orgId: string, invitationId: string): Promise<LinkIssue> {
      return db.kysely.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('invitations')
          .select(['id', 'org_id', 'expires_at', 'accepted_at'])
          .where('id', '=', invitationId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined || row.org_id !== orgId) return { status: 'not_found' };
        if (row.accepted_at !== null) return { status: 'used' };
        if (row.expires_at.getTime() <= Date.now()) return { status: 'expired' };

        const token = newToken();
        await trx
          .updateTable('invitations')
          .set({ token_hash: hashToken(token) })
          .where('id', '=', row.id)
          .execute();
        return { status: 'issued', token, expiresAt: row.expires_at };
      });
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
