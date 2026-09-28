import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { recordAuditEvent } from '@cuc/audit';
import type { Database } from '@cuc/db';

import type { IdentityServiceDb, UserOrgType } from '../schema.js';

/** `key_<12 hex>_<32 base64url>`: what a caller sends as `Authorization: Bearer <key>`. */
const KEY_FORMAT = /^key_([0-9a-f]{12})_([A-Za-z0-9_-]{32})$/;

/** Whether a bearer credential is shaped like an API key rather than an access token. */
export function looksLikeApiKey(credential: string): boolean {
  return credential.startsWith('key_');
}

/** An API key as it is listed: never its secret or hash. */
export interface ApiKey {
  readonly id: string;
  readonly orgId: string;
  readonly orgType: UserOrgType;
  readonly resellerId: string | null;
  readonly name: string;
  /** The key's public id, shown so a person can tell their keys apart: `key_<prefix>_…`. */
  readonly prefix: string;
  readonly permissions: readonly string[];
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface CreateApiKeyInput {
  readonly orgId: string;
  readonly orgType: UserOrgType;
  readonly resellerId: string | null;
  readonly name: string;
  readonly permissions: readonly string[];
  readonly expiresAt: Date | null;
}

/** Who is acting, for the audit trail. */
export interface ApiKeyActor {
  readonly actorId: string;
  readonly orgId: string;
  readonly requestId?: string | undefined;
  readonly ip?: string | undefined;
}

type Row = IdentityServiceDb['api_keys'];

function toApiKey(row: Row): ApiKey {
  return {
    id: row.id,
    orgId: row.org_id,
    orgType: row.org_type,
    resellerId: row.reseller_id,
    name: row.name,
    prefix: row.prefix,
    permissions: JSON.parse(row.permissions) as string[],
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

function hashOf(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Whether a key can be used at [now]: not revoked, not past its end date. */
export function isUsable(key: ApiKey, now: Date = new Date()): boolean {
  return key.revokedAt === null && (key.expiresAt === null || key.expiresAt > now);
}

/** How long a key's last use is left alone before it is written again. */
const LAST_USED_RESOLUTION_MS = 60_000;

/**
 * API keys (S1-08, G-14). Every write is audited in the same transaction
 * (`apikey.created`, `apikey.revoked`, class `secret` as 07 §3.3 files the
 * permission). A key's secret exists only in the answer to its creation.
 */
export function createApiKeyRepo(db: Database<IdentityServiceDb>) {
  const kysely = db.kysely;

  return {
    async create(
      actor: ApiKeyActor,
      input: CreateApiKeyInput,
      now: Date = new Date(),
    ): Promise<{ key: ApiKey; secret: string }> {
      const prefix = randomBytes(6).toString('hex');
      const secret = randomBytes(24).toString('base64url');
      const row: Row = {
        id: randomUUID(),
        org_id: input.orgId,
        org_type: input.orgType,
        reseller_id: input.resellerId,
        name: input.name,
        prefix,
        secret_hash: hashOf(secret),
        permissions: JSON.stringify([...new Set(input.permissions)].sort()),
        created_by: actor.actorId,
        created_at: now,
        expires_at: input.expiresAt,
        last_used_at: null,
        revoked_at: null,
      };
      await kysely.transaction().execute(async (trx) => {
        await trx.insertInto('api_keys').values(row).execute();
        await recordAuditEvent(trx, {
          actorType: 'user',
          actorId: actor.actorId,
          actorOrgId: actor.orgId,
          targetOrgId: input.orgId,
          action: 'apikey.created',
          resource: `apikey:${row.id}`,
          dataClass: 'secret',
          reason: `${input.name} (key_${prefix})`,
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          ...(actor.ip === undefined ? {} : { ip: actor.ip }),
        });
      });
      return { key: toApiKey(row), secret: `key_${prefix}_${secret}` };
    },

    async list(orgId: string): Promise<ApiKey[]> {
      const rows = await kysely
        .selectFrom('api_keys')
        .selectAll()
        .where('org_id', '=', orgId)
        .orderBy('created_at', 'desc')
        .execute();
      return rows.map(toApiKey);
    },

    async findById(orgId: string, id: string): Promise<ApiKey | undefined> {
      const row = await kysely
        .selectFrom('api_keys')
        .selectAll()
        .where('org_id', '=', orgId)
        .where('id', '=', id)
        .executeTakeFirst();
      return row === undefined ? undefined : toApiKey(row);
    },

    /** Ends a key for good. False when the org has no such key, or it was already revoked. */
    async revoke(
      actor: ApiKeyActor,
      orgId: string,
      id: string,
      now: Date = new Date(),
    ): Promise<boolean> {
      return kysely.transaction().execute(async (trx) => {
        const result = await trx
          .updateTable('api_keys')
          .set({ revoked_at: now })
          .where('org_id', '=', orgId)
          .where('id', '=', id)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        if (Number(result.numUpdatedRows) !== 1) return false;
        await recordAuditEvent(trx, {
          actorType: 'user',
          actorId: actor.actorId,
          actorOrgId: actor.orgId,
          targetOrgId: orgId,
          action: 'apikey.revoked',
          resource: `apikey:${id}`,
          dataClass: 'secret',
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          ...(actor.ip === undefined ? {} : { ip: actor.ip }),
        });
        return true;
      });
    },

    /**
     * The key a presented credential is, when it is a usable one; undefined for
     * anything else (malformed, unknown, wrong secret, revoked, expired). Its
     * last use is recorded, at most once a minute.
     */
    async verify(presented: string, now: Date = new Date()): Promise<ApiKey | undefined> {
      const match = KEY_FORMAT.exec(presented);
      if (match === null) return undefined;
      const row = await kysely
        .selectFrom('api_keys')
        .selectAll()
        .where('prefix', '=', match[1]!)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      const expected = Buffer.from(row.secret_hash, 'hex');
      const given = Buffer.from(hashOf(match[2]!), 'hex');
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
      const key = toApiKey(row);
      if (!isUsable(key, now)) return undefined;
      if (
        key.lastUsedAt === null ||
        now.getTime() - key.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS
      ) {
        await kysely
          .updateTable('api_keys')
          .set({ last_used_at: now })
          .where('id', '=', key.id)
          .execute();
      }
      return key;
    },
  };
}

export type ApiKeyRepo = ReturnType<typeof createApiKeyRepo>;
