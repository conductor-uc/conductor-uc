import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { isDuplicateKeyError } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';
import type { Kysely } from 'kysely';

import {
  generateVerificationToken,
  validateFqdn,
  verificationRecordMatches,
  verificationRecordName,
} from '../domain/domain.js';
import type { DnsResolver } from '../dns-resolver.js';
import { orgEvents } from '../events.js';
import type { BaseDomainStatus, OrgServiceDb } from '../schema.js';

export interface BaseDomain {
  readonly id: string;
  readonly resellerId: string;
  readonly fqdn: string;
  readonly status: BaseDomainStatus;
  readonly verificationRecordName: string;
  /** The TXT value to publish. Only meaningful while `status` is `pending`. */
  readonly verificationToken: string;
  readonly verifiedAt: Date | null;
}

export interface TenantDomain {
  readonly id: string;
  readonly tenantId: string;
  readonly fqdn: string;
  readonly isPrimary: boolean;
}

export class BaseDomainNotFoundError extends Error {
  override readonly name = 'BaseDomainNotFoundError';

  constructor(id: string) {
    super(`No base domain with id '${id}'.`);
  }
}

export class DomainTakenError extends Error {
  override readonly name = 'DomainTakenError';

  constructor(fqdn: string) {
    super(`The domain '${fqdn}' is already in use. Domains are globally unique (02 §3).`);
  }
}

/** DNS lookup failed, or the expected TXT record was not found among the results. */
export class DomainNotVerifiedError extends Error {
  override readonly name = 'DomainNotVerifiedError';
}

function toBaseDomain(row: {
  id: string;
  reseller_id: string;
  fqdn: string;
  status: BaseDomainStatus;
  verification_token: string;
  verified_at: Date | null;
}): BaseDomain {
  return {
    id: row.id,
    resellerId: row.reseller_id,
    fqdn: row.fqdn,
    status: row.status,
    verificationRecordName: verificationRecordName(row.fqdn),
    verificationToken: row.verification_token,
    verifiedAt: row.verified_at,
  };
}

/**
 * Data access for reseller base domains and their TXT-record verification
 * (02 §3). Tenant primary-domain assignment is not here — it happens
 * atomically inside `org.repo.ts`'s `create()`, in the same transaction as
 * the tenant row itself, since nothing prevents that one from being atomic
 * the way a cross-service call (identity-service's admin user) cannot be.
 */
export function createDomainRepo(db: Database<OrgServiceDb>) {
  const kysely = db.kysely;

  return {
    async findBaseDomain(id: string): Promise<BaseDomain | undefined> {
      const row = await kysely
        .selectFrom('reseller_base_domains')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row === undefined ? undefined : toBaseDomain(row);
    },

    async listBaseDomains(resellerId: string): Promise<BaseDomain[]> {
      const rows = await kysely
        .selectFrom('reseller_base_domains')
        .selectAll()
        .where('reseller_id', '=', resellerId)
        .orderBy('created_at', 'asc')
        .execute();
      return rows.map(toBaseDomain);
    },

    async findPrimaryTenantDomain(tenantId: string): Promise<TenantDomain | undefined> {
      const row = await kysely
        .selectFrom('tenant_domains')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('is_primary', '=', true)
        .executeTakeFirst();
      // mysql2 hands MariaDB's TINYINT(1) back as a JS number (0/1), not a
      // boolean — the same "the driver's actual shape doesn't match the
      // declared column type" surprise `org.repo.ts` hit for JSON columns.
      return row === undefined
        ? undefined
        : {
            id: row.id,
            tenantId: row.tenant_id,
            fqdn: row.fqdn,
            isPrimary: Boolean(row.is_primary),
          };
    },

    /**
     * Registers a candidate base domain for `resellerId`, `pending` until
     * {@link verifyBaseDomain} succeeds. Checked for uniqueness against both
     * domain tables, since "globally unique" (02 §3) spans both concepts.
     */
    async registerBaseDomain(resellerId: string, fqdn: string): Promise<BaseDomain> {
      const validated = validateFqdn(fqdn);
      const id = randomUUID();
      const token = generateVerificationToken();
      const now = new Date();

      return kysely.transaction().execute(async (trx) => {
        await assertDomainAvailable(trx, validated);

        try {
          await trx
            .insertInto('reseller_base_domains')
            .values({
              id,
              reseller_id: resellerId,
              fqdn: validated,
              verification_token: token,
              verified_at: null,
              status: 'pending',
              created_at: now,
              updated_at: now,
            })
            .execute();
        } catch (error) {
          if (isDuplicateKeyError(error)) throw new DomainTakenError(validated);
          throw error;
        }

        return {
          id,
          resellerId,
          fqdn: validated,
          status: 'pending',
          verificationRecordName: verificationRecordName(validated),
          verificationToken: token,
          verifiedAt: null,
        };
      });
    },

    /**
     * Looks up the TXT record {@link verificationRecordName} expects and
     * activates the domain if it matches. A DNS failure (NXDOMAIN, timeout,
     * anything) is reported the same way as a present-but-wrong record: the
     * caller only needs to know "not verified yet, try again once the record
     * is published", not the resolver's internal failure mode.
     */
    async verifyBaseDomain(
      ctx: DbContext,
      resellerId: string,
      id: string,
      resolver: DnsResolver,
    ): Promise<BaseDomain> {
      const row = await kysely
        .selectFrom('reseller_base_domains')
        .selectAll()
        .where('id', '=', id)
        .where('reseller_id', '=', resellerId)
        .executeTakeFirst();
      if (row === undefined) throw new BaseDomainNotFoundError(id);
      if (row.status === 'active') return toBaseDomain(row);

      let records: string[][];
      try {
        records = await resolver.resolveTxt(verificationRecordName(row.fqdn));
      } catch {
        throw new DomainNotVerifiedError(
          `No TXT record found at ${verificationRecordName(row.fqdn)}.`,
        );
      }
      if (!verificationRecordMatches(records, row.verification_token)) {
        throw new DomainNotVerifiedError(
          `${verificationRecordName(row.fqdn)} does not contain the expected token.`,
        );
      }

      const now = new Date();
      return kysely.transaction().execute(async (trx) => {
        await trx
          .updateTable('reseller_base_domains')
          .set({ status: 'active', verified_at: now, updated_at: now })
          .where('id', '=', id)
          .execute();

        await enqueueEvent(trx, orgEvents, {
          type: 'org.domain.added',
          data: { domainId: id, fqdn: row.fqdn, scope: 'reseller_base', ownerId: resellerId },
          ...eventMeta(ctx),
        });

        return toBaseDomain({ ...row, status: 'active', verified_at: now });
      });
    },
  };
}

/** Throws {@link DomainTakenError} if `fqdn` is already registered, as either kind of domain. */
async function assertDomainAvailable(trx: Kysely<OrgServiceDb>, fqdn: string): Promise<void> {
  const [asBaseDomain, asTenantDomain] = await Promise.all([
    trx
      .selectFrom('reseller_base_domains')
      .select('id')
      .where('fqdn', '=', fqdn)
      .executeTakeFirst(),
    trx.selectFrom('tenant_domains').select('id').where('fqdn', '=', fqdn).executeTakeFirst(),
  ]);
  if (asBaseDomain !== undefined || asTenantDomain !== undefined) throw new DomainTakenError(fqdn);
}

function eventMeta(ctx: DbContext): {
  actor?: { type: 'user'; id: string; orgId: string };
  correlationId?: string;
} {
  return {
    ...(ctx.actorId === undefined || ctx.orgId === undefined
      ? {}
      : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
    ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
  };
}

export type DomainRepo = ReturnType<typeof createDomainRepo>;
