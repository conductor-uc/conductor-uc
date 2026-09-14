import type { Database, DbContext } from '@cuc/db';
import { isDuplicateKeyError } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import { assertAccessiblePair, validateHexColor } from '../domain/color.js';
import { validateFqdn } from '../domain/domain.js';
import { orgEvents } from '../events.js';
import type { OrgServiceDb } from '../schema.js';

export interface Brand {
  readonly resellerId: string;
  readonly displayName: string | null;
  readonly primaryColor: string | null;
  readonly accentColor: string | null;
  readonly logoLightKey: string | null;
  readonly logoDarkKey: string | null;
  readonly faviconKey: string | null;
  readonly supportEmail: string | null;
  readonly supportUrl: string | null;
  readonly supportPhone: string | null;
  readonly emailFromName: string | null;
  readonly emailFromAddress: string | null;
  readonly sipUserAgent: string | null;
  readonly legalFooter: string | null;
}

/** Every field optional and independently nullable: omit a key to leave it alone, pass `null` to clear it. */
export interface BrandPatch {
  readonly displayName?: string | null;
  readonly primaryColor?: string | null;
  readonly accentColor?: string | null;
  readonly logoLightKey?: string | null;
  readonly logoDarkKey?: string | null;
  readonly faviconKey?: string | null;
  readonly supportEmail?: string | null;
  readonly supportUrl?: string | null;
  readonly supportPhone?: string | null;
  readonly emailFromName?: string | null;
  readonly emailFromAddress?: string | null;
  readonly sipUserAgent?: string | null;
  readonly legalFooter?: string | null;
}

export interface ConsoleHostname {
  readonly fqdn: string;
  readonly resellerId: string;
  readonly tlsStatus: string;
}

export class ConsoleHostnameTakenError extends Error {
  override readonly name = 'ConsoleHostnameTakenError';

  constructor(fqdn: string) {
    super(`The console hostname '${fqdn}' is already registered.`);
  }
}

const EMPTY_BRAND: Omit<Brand, 'resellerId'> = {
  displayName: null,
  primaryColor: null,
  accentColor: null,
  logoLightKey: null,
  logoDarkKey: null,
  faviconKey: null,
  supportEmail: null,
  supportUrl: null,
  supportPhone: null,
  emailFromName: null,
  emailFromAddress: null,
  sipUserAgent: null,
  legalFooter: null,
};

function toBrand(row: {
  reseller_id: string;
  display_name: string | null;
  primary_color: string | null;
  accent_color: string | null;
  logo_light_key: string | null;
  logo_dark_key: string | null;
  favicon_key: string | null;
  support_email: string | null;
  support_url: string | null;
  support_phone: string | null;
  email_from_name: string | null;
  email_from_address: string | null;
  sip_user_agent: string | null;
  legal_footer: string | null;
}): Brand {
  return {
    resellerId: row.reseller_id,
    displayName: row.display_name,
    primaryColor: row.primary_color,
    accentColor: row.accent_color,
    logoLightKey: row.logo_light_key,
    logoDarkKey: row.logo_dark_key,
    faviconKey: row.favicon_key,
    supportEmail: row.support_email,
    supportUrl: row.support_url,
    supportPhone: row.support_phone,
    emailFromName: row.email_from_name,
    emailFromAddress: row.email_from_address,
    sipUserAgent: row.sip_user_agent,
    legalFooter: row.legal_footer,
  };
}

/**
 * Data access for reseller brands (02 §5) and their console hostnames.
 * `brands` has at most one row per reseller — {@link upsertBrand} creates it
 * on first use rather than requiring a separate "create brand" step, since a
 * brand is conceptually a property of the reseller, not a thing with its own
 * lifecycle.
 */
export function createBrandRepo(db: Database<OrgServiceDb>) {
  const kysely = db.kysely;

  return {
    async findBrand(resellerId: string): Promise<Brand | undefined> {
      const row = await kysely
        .selectFrom('brands')
        .selectAll()
        .where('reseller_id', '=', resellerId)
        .executeTakeFirst();
      return row === undefined ? undefined : toBrand(row);
    },

    /**
     * Creates or updates the reseller's brand. Colors are validated as hex,
     * and — whenever the patch results in both `primaryColor` and
     * `accentColor` being set — validated together for WCAG AA contrast
     * (02 §5.3), merged against whatever the row already has so a partial
     * update can't slip an inaccessible pair past a check that only ever
     * looked at the one field being changed.
     */
    async upsertBrand(ctx: DbContext, resellerId: string, patch: BrandPatch): Promise<Brand> {
      return kysely.transaction().execute(async (trx) => {
        const existing = await trx
          .selectFrom('brands')
          .selectAll()
          .where('reseller_id', '=', resellerId)
          .executeTakeFirst();
        const current = existing === undefined ? { resellerId, ...EMPTY_BRAND } : toBrand(existing);

        const merged: Brand = {
          resellerId,
          displayName: patch.displayName === undefined ? current.displayName : patch.displayName,
          primaryColor:
            patch.primaryColor === undefined ? current.primaryColor : patch.primaryColor,
          accentColor: patch.accentColor === undefined ? current.accentColor : patch.accentColor,
          logoLightKey:
            patch.logoLightKey === undefined ? current.logoLightKey : patch.logoLightKey,
          logoDarkKey: patch.logoDarkKey === undefined ? current.logoDarkKey : patch.logoDarkKey,
          faviconKey: patch.faviconKey === undefined ? current.faviconKey : patch.faviconKey,
          supportEmail:
            patch.supportEmail === undefined ? current.supportEmail : patch.supportEmail,
          supportUrl: patch.supportUrl === undefined ? current.supportUrl : patch.supportUrl,
          supportPhone:
            patch.supportPhone === undefined ? current.supportPhone : patch.supportPhone,
          emailFromName:
            patch.emailFromName === undefined ? current.emailFromName : patch.emailFromName,
          emailFromAddress:
            patch.emailFromAddress === undefined
              ? current.emailFromAddress
              : patch.emailFromAddress,
          sipUserAgent:
            patch.sipUserAgent === undefined ? current.sipUserAgent : patch.sipUserAgent,
          legalFooter: patch.legalFooter === undefined ? current.legalFooter : patch.legalFooter,
        };

        if (merged.primaryColor !== null) validateHexColor(merged.primaryColor);
        if (merged.accentColor !== null) validateHexColor(merged.accentColor);
        if (merged.primaryColor !== null && merged.accentColor !== null) {
          assertAccessiblePair(merged.primaryColor, merged.accentColor);
        }

        const now = new Date();
        const row = {
          display_name: merged.displayName,
          primary_color: merged.primaryColor,
          accent_color: merged.accentColor,
          logo_light_key: merged.logoLightKey,
          logo_dark_key: merged.logoDarkKey,
          favicon_key: merged.faviconKey,
          support_email: merged.supportEmail,
          support_url: merged.supportUrl,
          support_phone: merged.supportPhone,
          email_from_name: merged.emailFromName,
          email_from_address: merged.emailFromAddress,
          sip_user_agent: merged.sipUserAgent,
          legal_footer: merged.legalFooter,
        };

        if (existing === undefined) {
          await trx
            .insertInto('brands')
            .values({ reseller_id: resellerId, ...row, created_at: now, updated_at: now })
            .execute();
        } else {
          await trx
            .updateTable('brands')
            .set({ ...row, updated_at: now })
            .where('reseller_id', '=', resellerId)
            .execute();
        }

        await enqueueEvent(trx, orgEvents, {
          type: 'org.brand.updated',
          data: { resellerId },
          ...eventMeta(ctx),
        });

        return merged;
      });
    },

    async registerConsoleHostname(resellerId: string, fqdn: string): Promise<ConsoleHostname> {
      const validated = validateFqdn(fqdn);
      try {
        await kysely
          .insertInto('console_hostnames')
          .values({
            fqdn: validated,
            reseller_id: resellerId,
            tls_status: 'pending',
            created_at: new Date(),
          })
          .execute();
      } catch (error) {
        if (isDuplicateKeyError(error)) throw new ConsoleHostnameTakenError(validated);
        throw error;
      }
      return { fqdn: validated, resellerId, tlsStatus: 'pending' };
    },

    async listConsoleHostnames(resellerId: string): Promise<ConsoleHostname[]> {
      const rows = await kysely
        .selectFrom('console_hostnames')
        .selectAll()
        .where('reseller_id', '=', resellerId)
        .orderBy('created_at', 'asc')
        .execute();
      return rows.map((row) => ({
        fqdn: row.fqdn,
        resellerId: row.reseller_id,
        tlsStatus: row.tls_status,
      }));
    },

    /** The reseller id `fqdn` is registered to as a console hostname, or `undefined` if it isn't one (02 §5.2). */
    async findResellerIdForHostname(fqdn: string): Promise<string | undefined> {
      const row = await kysely
        .selectFrom('console_hostnames')
        .select('reseller_id')
        .where('fqdn', '=', fqdn)
        .executeTakeFirst();
      return row?.reseller_id;
    },
  };
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

export type BrandRepo = ReturnType<typeof createBrandRepo>;
