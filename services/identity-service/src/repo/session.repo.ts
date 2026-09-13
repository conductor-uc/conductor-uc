import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Database, Kysely } from '@cuc/db';

import type { IdentityServiceDb } from '../schema.js';

/** A newly created session, with the raw refresh token — never stored, only returned once. */
export interface NewSession {
  readonly sessionId: string;
  readonly familyId: string;
  readonly refreshToken: string;
  readonly expiresAt: Date;
}

export interface SessionRow {
  readonly id: string;
  readonly userId: string;
  readonly familyId: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

/**
 * Data access for sessions (refresh tokens).
 *
 * The raw token is generated and returned here, but never stored — only its
 * SHA-256 hash is. Losing this table to a read-only breach exposes nothing
 * usable; `refresh_hash` alone cannot be replayed. Not tenant-scoped (`users`
 * isn't a `TenantOwnedTable` either — see `schema.ts`); every read here is by
 * hash, id, or family id, none of which need an org filter to stay correct.
 */
export function createSessionRepo(db: Database<IdentityServiceDb>) {
  const sessions = db.kysely;

  function toRow(row: {
    id: string;
    user_id: string;
    family_id: string;
    expires_at: Date;
    revoked_at: Date | null;
  }): SessionRow {
    return {
      id: row.id,
      userId: row.user_id,
      familyId: row.family_id,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    };
  }

  return {
    /**
     * Starts a new family (a fresh login). Every rotation of this session
     * shares `familyId`, which is what lets a reuse revoke the whole chain.
     */
    async create(
      userId: string,
      ttlDays: number,
      meta: { ip: string | null; ua: string | null },
    ): Promise<NewSession> {
      return insertSession(sessions, userId, randomUUID(), ttlDays, meta);
    },

    /**
     * Rotates a session that presented a valid, unused refresh token: the old
     * row is marked revoked and a new one is inserted in its place, same
     * family, in one transaction — a crash between the two must not leave the
     * old token usable *and* absent from the new chain. Revoking the old row
     * is what turns a later replay of it into a detected reuse.
     */
    async rotate(
      oldSessionId: string,
      userId: string,
      familyId: string,
      ttlDays: number,
      meta: { ip: string | null; ua: string | null },
    ): Promise<NewSession> {
      return db.kysely.transaction().execute(async (trx) => {
        await trx
          .updateTable('sessions')
          .set({ revoked_at: new Date() })
          .where('id', '=', oldSessionId)
          .execute();
        return insertSession(trx, userId, familyId, ttlDays, meta);
      });
    },

    findByToken: async (refreshToken: string): Promise<SessionRow | undefined> => {
      const row = await sessions
        .selectFrom('sessions')
        .select(['id', 'user_id', 'family_id', 'expires_at', 'revoked_at'])
        .where('refresh_hash', '=', hashToken(refreshToken))
        .executeTakeFirst();
      return row === undefined ? undefined : toRow(row);
    },

    /** A normal, deliberate logout: revokes one session, not its whole family. */
    revoke: async (sessionId: string): Promise<void> => {
      await sessions
        .updateTable('sessions')
        .set({ revoked_at: new Date() })
        .where('id', '=', sessionId)
        .where('revoked_at', 'is', null)
        .execute();
    },

    /**
     * Reuse of an already-rotated refresh token revokes every session sharing
     * its family (07 §2) — the whole chain is presumed compromised, not just
     * the one token that was replayed.
     */
    revokeFamily: async (familyId: string): Promise<void> => {
      await sessions
        .updateTable('sessions')
        .set({ revoked_at: new Date() })
        .where('family_id', '=', familyId)
        .where('revoked_at', 'is', null)
        .execute();
    },
  };
}

export type SessionRepo = ReturnType<typeof createSessionRepo>;

async function insertSession(
  db: Kysely<IdentityServiceDb>,
  userId: string,
  familyId: string,
  ttlDays: number,
  meta: { ip: string | null; ua: string | null },
): Promise<NewSession> {
  const refreshToken = randomBytes(32).toString('base64url');
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  await db
    .insertInto('sessions')
    .values({
      id: sessionId,
      user_id: userId,
      refresh_hash: hashToken(refreshToken),
      family_id: familyId,
      expires_at: expiresAt,
      revoked_at: null,
      ip: meta.ip,
      ua: meta.ua,
      created_at: new Date(),
    })
    .execute();

  return { sessionId, familyId, refreshToken, expiresAt };
}

/**
 * SHA-256 is deliberately not a slow hash: unlike a password, a refresh token
 * is already 256 bits of real randomness, so there is nothing for a slow hash
 * to protect against — the only question a lookup needs answered is equality.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
