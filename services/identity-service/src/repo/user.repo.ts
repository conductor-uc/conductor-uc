import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { isDuplicateKeyError } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import { normalizeEmail } from '../domain/email.js';
import { hashPassword } from '../domain/password.js';
import { identityEvents } from '../events.js';
import type { IdentityServiceDb, UserOrgType, UserStatus } from '../schema.js';

export interface User {
  readonly id: string;
  readonly orgId: string;
  readonly orgType: UserOrgType;
  readonly resellerId: string | null;
  readonly email: string;
  readonly displayName: string;
  readonly status: UserStatus;
  readonly mfaEnrolled: boolean;
}

/** A user as the users screen lists them. */
export interface UserListing extends User {
  readonly lastLoginAt: Date | null;
}

/** Carries the hash too — only for the login path, never returned from the API. */
export interface UserWithHash extends User {
  readonly passwordHash: string;
}

export class EmailTakenError extends Error {
  override readonly name = 'EmailTakenError';

  constructor(email: string) {
    super(`The email '${email}' is already in use in this org (05 §3.2).`);
  }
}

/**
 * Data access for users.
 *
 * `users.org_id` can name a master, reseller, or tenant org — not only a
 * tenant — so this does not go through `scoped(ctx)` (see `IdentityServiceDb`
 * in `schema.ts`). Every read here takes an explicit `orgId` and filters on it,
 * which is the org-ancestry check `@cuc/authz` (S1-06) will eventually make
 * mechanical; until then, this repository's callers are the access control.
 */
export function createUserRepo(db: Database<IdentityServiceDb>) {
  const users = db.kysely;

  function toUser(row: {
    id: string;
    org_id: string;
    org_type: UserOrgType;
    reseller_id: string | null;
    email: string;
    display_name: string;
    status: UserStatus;
    mfa_enrolled: boolean;
  }): User {
    return {
      id: row.id,
      orgId: row.org_id,
      orgType: row.org_type,
      resellerId: row.reseller_id,
      email: row.email,
      displayName: row.display_name,
      status: row.status,
      mfaEnrolled: row.mfa_enrolled,
    };
  }

  return {
    findByOrgAndEmail: async (
      orgId: string,
      emailInput: string,
    ): Promise<UserWithHash | undefined> => {
      const email = normalizeEmail(emailInput);
      const row = await users
        .selectFrom('users')
        .selectAll()
        .where('org_id', '=', orgId)
        .where('email', '=', email)
        .executeTakeFirst();
      return row === undefined ? undefined : { ...toUser(row), passwordHash: row.password_hash };
    },

    findById: async (id: string): Promise<User | undefined> => {
      const row = await users
        .selectFrom('users')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row === undefined ? undefined : toUser(row);
    },

    /**
     * Creates a user, publishing `identity.user.created`. Only caller today is
     * the internal admin-creation endpoint (S1-05's stated scope); ordinary
     * user CRUD is a later task.
     */
    async create(
      ctx: DbContext,
      input: {
        orgId: string;
        orgType: UserOrgType;
        resellerId: string | null;
        email: string;
        displayName: string;
        password: string;
      },
    ): Promise<User> {
      const email = normalizeEmail(input.email);
      const id = randomUUID();
      const now = new Date();
      const passwordHash = await hashPassword(input.password);

      return db.kysely.transaction().execute(async (trx) => {
        try {
          await trx
            .insertInto('users')
            .values({
              id,
              org_id: input.orgId,
              org_type: input.orgType,
              reseller_id: input.resellerId,
              email,
              display_name: input.displayName,
              password_hash: passwordHash,
              status: 'active',
              mfa_enrolled: false,
              last_login_at: null,
              created_at: now,
              updated_at: now,
              version: 1,
            })
            .execute();
        } catch (error) {
          if (isDuplicateKeyError(error)) throw new EmailTakenError(email);
          throw error;
        }

        await enqueueEvent(trx, identityEvents, {
          type: 'identity.user.created',
          data: { userId: id, orgId: input.orgId, email },
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });

        return {
          id,
          orgId: input.orgId,
          orgType: input.orgType,
          resellerId: input.resellerId,
          email,
          displayName: input.displayName,
          status: 'active',
          mfaEnrolled: false,
        };
      });
    },

    /** Everyone in one org, by email, for the users screen. */
    listByOrg: async (orgId: string): Promise<UserListing[]> => {
      const rows = await users
        .selectFrom('users')
        .selectAll()
        .where('org_id', '=', orgId)
        .orderBy('email', 'asc')
        .execute();
      return rows.map((row) => ({ ...toUser(row), lastLoginAt: row.last_login_at }));
    },

    /**
     * Changes a user's display name or status, and publishes
     * `identity.user.updated`. Disabling also revokes every session the user
     * has, in the same transaction: a disabled user must not stay signed in.
     * Undefined when no user with that id is in `orgId`.
     */
    async update(
      ctx: DbContext,
      orgId: string,
      userId: string,
      changes: { displayName?: string; status?: UserStatus },
    ): Promise<UserListing | undefined> {
      return users.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('users')
          .selectAll()
          .where('id', '=', userId)
          .where('org_id', '=', orgId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return undefined;

        const now = new Date();
        const status = changes.status ?? row.status;
        const displayName = changes.displayName ?? row.display_name;
        await trx
          .updateTable('users')
          .set({
            display_name: displayName,
            status,
            updated_at: now,
            version: row.version + 1,
          })
          .where('id', '=', userId)
          .execute();
        if (status === 'disabled' && row.status !== 'disabled') {
          await trx
            .updateTable('sessions')
            .set({ revoked_at: now })
            .where('user_id', '=', userId)
            .where('revoked_at', 'is', null)
            .execute();
        }

        await enqueueEvent(trx, identityEvents, {
          type: 'identity.user.updated',
          data: { userId, orgId, status },
          ...(ctx.actorId === undefined || ctx.orgId === undefined
            ? {}
            : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });

        return {
          ...toUser({ ...row, display_name: displayName, status }),
          lastLoginAt: row.last_login_at,
        };
      });
    },

    /** Replaces a user's password hash. Used by a completed password reset. */
    setPassword: async (userId: string, password: string): Promise<void> => {
      const passwordHash = await hashPassword(password);
      await users
        .updateTable('users')
        .set((eb) => ({
          password_hash: passwordHash,
          updated_at: new Date(),
          version: eb('version', '+', 1),
        }))
        .where('id', '=', userId)
        .execute();
    },

    markMfaEnrolled: async (userId: string): Promise<void> => {
      await users
        .updateTable('users')
        .set({ mfa_enrolled: true, updated_at: new Date() })
        .where('id', '=', userId)
        .execute();
    },

    recordLogin: async (userId: string): Promise<void> => {
      await users
        .updateTable('users')
        .set({ last_login_at: new Date() })
        .where('id', '=', userId)
        .execute();
    },
  };
}

export type UserRepo = ReturnType<typeof createUserRepo>;
