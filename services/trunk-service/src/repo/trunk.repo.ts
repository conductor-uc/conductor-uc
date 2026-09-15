import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { isDuplicateKeyError, requireTenant } from '@cuc/db';
import type { KekProvider } from '@cuc/crypto';
import { decryptString, encrypt } from '@cuc/crypto';
import { enqueueEvent } from '@cuc/events';

import {
  InvalidTrunkConfigError,
  validateCallerIdPolicy,
  validateCidr,
  validateCodecs,
  validateCredentialForAuthMode,
  validateMaxChannels,
  type AuthMode,
  type CallerIdPolicy,
} from '../domain/trunk.js';
import { trunkEvents } from '../events.js';
import type { TenantResellerLookup } from '../org-client.js';
import type { TrunkServiceDb } from '../schema.js';

export interface Trunk {
  readonly id: string;
  readonly tenantId: string;
  readonly resellerId: string;
  readonly name: string;
  readonly authMode: AuthMode;
  readonly host: string;
  readonly port: number;
  readonly transport: string;
  /** Register auth username. Null when `authMode` is `ip` — never the secret itself. */
  readonly username: string | null;
  readonly fromDomain: string | null;
  readonly codecs: readonly string[];
  readonly maxChannels: number | null;
  readonly callerIdPolicy: CallerIdPolicy | null;
  readonly status: string;
}

export interface TrunkIp {
  readonly id: string;
  readonly trunkId: string;
  readonly cidr: string;
}

export interface CreateTrunkInput {
  readonly name: string;
  readonly authMode: AuthMode;
  readonly host: string;
  readonly port: number;
  readonly transport: string;
  readonly username?: string | null;
  readonly secret?: string | null;
  readonly fromDomain?: string | null;
  readonly codecs: readonly string[];
  readonly maxChannels?: number | null;
  readonly callerIdPolicy?: CallerIdPolicy | null;
}

export interface UpdateTrunkInput {
  readonly name?: string;
  readonly authMode?: AuthMode;
  readonly host?: string;
  readonly port?: number;
  readonly transport?: string;
  readonly username?: string | null;
  /** Omitted: keep the current secret. Present (including null): rotate/clear it. */
  readonly secret?: string | null;
  readonly fromDomain?: string | null;
  readonly codecs?: readonly string[];
  readonly maxChannels?: number | null;
  readonly callerIdPolicy?: CallerIdPolicy | null;
  readonly status?: string;
}

/** What `:reveal` returns — the one place the plaintext register secret ever leaves this service. */
export interface RevealedTrunkCredential {
  readonly username: string;
  readonly secret: string;
}

export class TrunkNotFoundError extends Error {
  override readonly name = 'TrunkNotFoundError';
}

export class TrunkNameTakenError extends Error {
  override readonly name = 'TrunkNameTakenError';
}

export class TenantResellerNotFoundError extends Error {
  override readonly name = 'TenantResellerNotFoundError';

  constructor(tenantId: string) {
    super(`Tenant '${tenantId}' has no owning reseller — a trunk cannot be created for it.`);
  }
}

export class TrunkHasNoCredentialError extends Error {
  override readonly name = 'TrunkHasNoCredentialError';
}

export class TrunkIpNotFoundError extends Error {
  override readonly name = 'TrunkIpNotFoundError';
}

function associatedData(tenantId: string, trunkId: string): string {
  return `${tenantId}:trunks.secret_enc:${trunkId}`;
}

interface TrunkRow {
  id: string;
  tenant_id: string;
  reseller_id: string;
  name: string;
  auth_mode: string;
  host: string;
  port: number;
  transport: string;
  username: string | null;
  from_domain: string | null;
  codecs: string;
  max_channels: number | null;
  caller_id_policy: string | null;
  status: string;
}

/**
 * `trunks.codecs`/`caller_id_policy` are declared `json` in the migration,
 * but whether the driver hands them back already parsed depends on the
 * server: MariaDB's docs say JSON columns are LONGTEXT under the hood, yet
 * mysql2 parses it into an object regardless (the same discovery org-service's
 * `org.repo.ts` `parseLimits` made for `orgs.limits`) — so these accept either
 * shape rather than assume one.
 */
function parseJsonCodecs(value: unknown): string[] {
  return typeof value === 'string' ? (JSON.parse(value) as string[]) : (value as string[]);
}

function parseJsonCallerIdPolicy(value: unknown): CallerIdPolicy | null {
  if (value === null) return null;
  return typeof value === 'string' ? (JSON.parse(value) as CallerIdPolicy) : (value as CallerIdPolicy);
}

function toTrunk(row: TrunkRow): Trunk {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    resellerId: row.reseller_id,
    name: row.name,
    authMode: row.auth_mode as AuthMode,
    host: row.host,
    port: row.port,
    transport: row.transport,
    username: row.username,
    fromDomain: row.from_domain,
    codecs: parseJsonCodecs(row.codecs),
    maxChannels: row.max_channels,
    callerIdPolicy: parseJsonCallerIdPolicy(row.caller_id_policy),
    status: row.status,
  };
}

const TRUNK_COLUMNS = [
  'id',
  'tenant_id',
  'reseller_id',
  'name',
  'auth_mode',
  'host',
  'port',
  'transport',
  'username',
  'from_domain',
  'codecs',
  'max_channels',
  'caller_id_policy',
  'status',
] as const;

/**
 * Data access for trunks and their inbound IPs (S2-01; 05 §3.4).
 *
 * Every query goes through `scoped(ctx)` (CLAUDE.md rule 2). A trunk's
 * plaintext register secret exists only for the instant `create`/`update`
 * encrypts it — never logged, never returned from anything but `reveal`, and
 * `secret_enc` is envelope-encrypted at rest (07 §5).
 */
export function createTrunkRepo(
  db: Database<TrunkServiceDb>,
  resellers: TenantResellerLookup,
  kek: KekProvider,
) {
  return {
    list: (ctx: DbContext): Promise<Trunk[]> =>
      db
        .scoped(ctx)
        .selectFrom('trunks')
        .select(TRUNK_COLUMNS)
        .orderBy('name', 'asc')
        .execute()
        .then((rows) => rows.map(toTrunk)),

    findById: (ctx: DbContext, id: string): Promise<Trunk | undefined> =>
      db
        .scoped(ctx)
        .selectFrom('trunks')
        .select(TRUNK_COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : toTrunk(row))),

    listIps: (ctx: DbContext, trunkId: string): Promise<TrunkIp[]> =>
      db
        .scoped(ctx)
        .selectFrom('trunk_ips')
        .select(['id', 'trunk_id', 'cidr'])
        .where('trunk_id', '=', trunkId)
        .orderBy('cidr', 'asc')
        .execute()
        .then((rows) => rows.map((row) => ({ id: row.id, trunkId: row.trunk_id, cidr: row.cidr }))),

    /**
     * Creates the trunk (its owning reseller looked up from org-service
     * first — a read from another service, not a row this transaction could
     * roll back anyway) and the `trunk.trunk.created` event in one
     * transaction (CLAUDE.md rule 6).
     */
    async create(ctx: DbContext, input: CreateTrunkInput): Promise<Trunk> {
      validateCredentialForAuthMode({
        authMode: input.authMode,
        hasUsername: input.username !== undefined && input.username !== null,
        hasSecret: input.secret !== undefined && input.secret !== null,
      });
      const codecs = validateCodecs(input.codecs);
      const maxChannels = validateMaxChannels(input.maxChannels);
      const callerIdPolicy = validateCallerIdPolicy(input.callerIdPolicy);
      const { tenantId } = requireTenant(ctx);

      const resellerId = await resellers(tenantId);
      if (resellerId === undefined) throw new TenantResellerNotFoundError(tenantId);

      const id = randomUUID();
      const now = new Date();
      const username = input.username ?? null;
      const secretEnc =
        input.secret === undefined || input.secret === null
          ? null
          : await encrypt(kek, input.secret, associatedData(tenantId, id));
      const fromDomain = input.fromDomain ?? null;

      try {
        await db.scoped(ctx).transaction(async (trx, raw) => {
          await trx
            .insertInto('trunks')
            .values({
              id,
              reseller_id: resellerId,
              name: input.name,
              auth_mode: input.authMode,
              host: input.host,
              port: input.port,
              transport: input.transport,
              username,
              secret_enc: secretEnc,
              from_domain: fromDomain,
              codecs: JSON.stringify(codecs),
              max_channels: maxChannels,
              caller_id_policy: callerIdPolicy === null ? null : JSON.stringify(callerIdPolicy),
              status: 'active',
              created_at: now,
              updated_at: now,
              version: 1,
            })
            .execute();

          await enqueueEvent(raw, trunkEvents, {
            type: 'trunk.trunk.created',
            data: { trunkId: id, name: input.name, authMode: input.authMode },
            orgContext: { tenantId },
            ...(ctx.actorId === undefined || ctx.orgId === undefined
              ? {}
              : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
            ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
          });
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) throw new TrunkNameTakenError(input.name);
        throw error;
      }

      return {
        id,
        tenantId,
        resellerId,
        name: input.name,
        authMode: input.authMode,
        host: input.host,
        port: input.port,
        transport: input.transport,
        username,
        fromDomain,
        codecs,
        maxChannels,
        callerIdPolicy,
        status: 'active',
      };
    },

    async update(ctx: DbContext, id: string, input: UpdateTrunkInput): Promise<Trunk> {
      const { tenantId } = requireTenant(ctx);
      const existing = await db
        .scoped(ctx)
        .selectFrom('trunks')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing === undefined) throw new TrunkNotFoundError(`No trunk with id '${id}'.`);

      const authMode = (input.authMode ?? existing.auth_mode) as AuthMode;
      const username = input.username === undefined ? existing.username : input.username;
      const secretGiven = input.secret !== undefined;
      const willHaveSecret = secretGiven ? input.secret !== null : existing.secret_enc !== null;
      validateCredentialForAuthMode({
        authMode,
        hasUsername: username !== null,
        hasSecret: willHaveSecret,
      });
      const codecs =
        input.codecs === undefined ? parseJsonCodecs(existing.codecs) : validateCodecs(input.codecs);
      const maxChannels =
        input.maxChannels === undefined ? existing.max_channels : validateMaxChannels(input.maxChannels);
      const callerIdPolicy =
        input.callerIdPolicy === undefined
          ? parseJsonCallerIdPolicy(existing.caller_id_policy)
          : validateCallerIdPolicy(input.callerIdPolicy);

      const secretEnc = secretGiven
        ? input.secret === null
          ? null
          : await encrypt(kek, input.secret, associatedData(tenantId, id))
        : existing.secret_enc;

      const merged = {
        name: input.name ?? existing.name,
        auth_mode: authMode,
        host: input.host ?? existing.host,
        port: input.port ?? existing.port,
        transport: input.transport ?? existing.transport,
        username,
        secret_enc: secretEnc,
        from_domain: input.fromDomain === undefined ? existing.from_domain : input.fromDomain,
        codecs: JSON.stringify(codecs),
        max_channels: maxChannels,
        caller_id_policy: callerIdPolicy === null ? null : JSON.stringify(callerIdPolicy),
        status: input.status ?? existing.status,
      };

      try {
        await db.scoped(ctx).transaction(async (trx, raw) => {
          await trx
            .updateTable('trunks')
            .set({ ...merged, updated_at: new Date(), version: existing.version + 1 })
            .where('id', '=', id)
            .execute();

          await enqueueEvent(raw, trunkEvents, {
            type: 'trunk.trunk.updated',
            data: { trunkId: id },
            orgContext: { tenantId },
            ...(ctx.actorId === undefined || ctx.orgId === undefined
              ? {}
              : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
            ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
          });
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) throw new TrunkNameTakenError(merged.name);
        throw error;
      }

      return {
        id,
        tenantId: existing.tenant_id,
        resellerId: existing.reseller_id,
        name: merged.name,
        authMode: merged.auth_mode,
        host: merged.host,
        port: merged.port,
        transport: merged.transport,
        username: merged.username,
        fromDomain: merged.from_domain,
        codecs,
        maxChannels,
        callerIdPolicy,
        status: merged.status,
      };
    },

    async remove(ctx: DbContext, id: string): Promise<void> {
      const { tenantId } = requireTenant(ctx);

      await db.scoped(ctx).transaction(async (trx, raw) => {
        await trx.deleteFrom('trunk_ips').where('trunk_id', '=', id).execute();
        const result = await trx.deleteFrom('trunks').where('id', '=', id).executeTakeFirst();
        if (Number(result.numDeletedRows) === 0) {
          throw new TrunkNotFoundError(`No trunk with id '${id}'.`);
        }

        await enqueueEvent(raw, trunkEvents, {
          type: 'trunk.trunk.deleted',
          data: { trunkId: id },
          orgContext: { tenantId },
          ...(ctx.actorId === undefined || ctx.orgId === undefined
            ? {}
            : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });
    },

    async addIp(ctx: DbContext, trunkId: string, cidr: string): Promise<TrunkIp> {
      requireTenant(ctx);
      const trunk = await db
        .scoped(ctx)
        .selectFrom('trunks')
        .select('id')
        .where('id', '=', trunkId)
        .executeTakeFirst();
      if (trunk === undefined) throw new TrunkNotFoundError(`No trunk with id '${trunkId}'.`);

      const validated = validateCidr(cidr);
      const id = randomUUID();
      try {
        await db
          .scoped(ctx)
          .insertInto('trunk_ips')
          .values({ id, trunk_id: trunkId, cidr: validated, created_at: new Date() })
          .execute();
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new InvalidTrunkConfigError(`'${validated}' is already on this trunk.`);
        }
        throw error;
      }

      return { id, trunkId, cidr: validated };
    },

    async removeIp(ctx: DbContext, trunkId: string, ipId: string): Promise<void> {
      const result = await db
        .scoped(ctx)
        .deleteFrom('trunk_ips')
        .where('trunk_id', '=', trunkId)
        .where('id', '=', ipId)
        .executeTakeFirst();
      if (Number(result.numDeletedRows) === 0) {
        throw new TrunkIpNotFoundError(`No IP '${ipId}' on trunk '${trunkId}'.`);
      }
    },

    /**
     * Decrypts and returns the register secret (06-style precedent, S1-09's
     * `:reveal`): never returned by list/get/create/update, only through this
     * one audited, permissioned action.
     */
    async reveal(ctx: DbContext, trunkId: string): Promise<RevealedTrunkCredential> {
      const trunk = await db
        .scoped(ctx)
        .selectFrom('trunks')
        .select(['tenant_id', 'username', 'secret_enc'])
        .where('id', '=', trunkId)
        .executeTakeFirst();
      if (trunk === undefined) throw new TrunkNotFoundError(`No trunk with id '${trunkId}'.`);
      if (trunk.username === null || trunk.secret_enc === null) {
        throw new TrunkHasNoCredentialError(`Trunk '${trunkId}' has no register credential to reveal.`);
      }

      const secret = await decryptString(kek, trunk.secret_enc, associatedData(trunk.tenant_id, trunkId));
      return { username: trunk.username, secret };
    },
  };
}

export type TrunkRepo = ReturnType<typeof createTrunkRepo>;
