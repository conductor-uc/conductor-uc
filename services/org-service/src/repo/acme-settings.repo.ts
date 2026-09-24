import type { Database } from '@cuc/db';

import { ACME_DIRECTORY_URLS, acmeReady, validateContactEmail } from '../domain/acme.js';
import type { AcmeDirectory, OrgServiceDb } from '../schema.js';

export interface AcmeSettings {
  readonly contactEmail: string | null;
  readonly directory: AcmeDirectory;
  /** Where the ACME client actually connects: the chosen directory's address, unless a deployment overrides it. */
  readonly directoryUrl: string;
  /** Whether the terms were agreed to for the directory chosen now. */
  readonly termsAgreed: boolean;
  readonly termsAgreedAt: Date | null;
  readonly termsAgreedBy: string | null;
  readonly termsUrl: string | null;
  /** Whether certificates will be requested: an address is set and the terms are agreed. */
  readonly ready: boolean;
}

export interface SaveAcmeSettingsInput {
  readonly contactEmail: string | null | undefined;
  readonly directory: AcmeDirectory;
  /** True to agree (or stay agreed) for [directory]; false to withdraw. */
  readonly agreeToTerms: boolean;
  /** The subscriber agreement's address as it stands now, kept with the agreement. */
  readonly termsUrl: string | null;
  readonly actorId: string;
  readonly now?: Date;
}

const ROW_ID = 1;

export interface AcmeSettingsRepoOptions {
  /**
   * Overrides both directories' address. For a deployment that runs its own
   * ACME server (and for tests against Pebble); never set in production.
   */
  readonly directoryUrlOverride?: string | undefined;
}

/**
 * The platform's Let's Encrypt settings: one row, edited in the console. Until
 * an address is saved and the terms are agreed for the chosen directory, the
 * issuing worker requests nothing.
 */
export function createAcmeSettingsRepo(
  db: Database<OrgServiceDb>,
  options: AcmeSettingsRepoOptions = {},
) {
  const kysely = db.kysely;

  function toSettings(
    row:
      | {
          contact_email: string | null;
          directory: AcmeDirectory;
          terms_agreed_directory: AcmeDirectory | null;
          terms_agreed_at: Date | null;
          terms_agreed_by: string | null;
          terms_url: string | null;
        }
      | undefined,
  ): AcmeSettings {
    const directory = row?.directory ?? 'production';
    const contactEmail = row?.contact_email ?? null;
    const termsAgreedDirectory = row?.terms_agreed_directory ?? null;
    return {
      contactEmail,
      directory,
      directoryUrl: options.directoryUrlOverride ?? ACME_DIRECTORY_URLS[directory],
      termsAgreed: termsAgreedDirectory === directory,
      termsAgreedAt: termsAgreedDirectory === directory ? (row?.terms_agreed_at ?? null) : null,
      termsAgreedBy: termsAgreedDirectory === directory ? (row?.terms_agreed_by ?? null) : null,
      termsUrl: termsAgreedDirectory === directory ? (row?.terms_url ?? null) : null,
      ready: acmeReady({ contactEmail, directory, termsAgreedDirectory }),
    };
  }

  return {
    async get(): Promise<AcmeSettings> {
      const row = await kysely
        .selectFrom('acme_settings')
        .selectAll()
        .where('id', '=', ROW_ID)
        .executeTakeFirst();
      return toSettings(row);
    },

    /**
     * Saves the address and the choice of directory, and records who agreed to the
     * terms and when. Agreement belongs to one directory: changing the directory
     * without agreeing again leaves it un-agreed, and withdrawing clears it. Agreeing
     * again to what was already agreed keeps the original who and when.
     */
    async save(input: SaveAcmeSettingsInput): Promise<AcmeSettings> {
      const now = input.now ?? new Date();
      const contactEmail = validateContactEmail(input.contactEmail);
      const existing = await kysely
        .selectFrom('acme_settings')
        .selectAll()
        .where('id', '=', ROW_ID)
        .executeTakeFirst();

      const alreadyAgreed =
        existing?.terms_agreed_directory === input.directory && input.agreeToTerms;
      const agreement = input.agreeToTerms
        ? alreadyAgreed
          ? {
              terms_agreed_directory: existing.terms_agreed_directory,
              terms_agreed_at: existing.terms_agreed_at,
              terms_agreed_by: existing.terms_agreed_by,
              terms_url: existing.terms_url,
            }
          : {
              terms_agreed_directory: input.directory,
              terms_agreed_at: now,
              terms_agreed_by: input.actorId,
              terms_url: input.termsUrl,
            }
        : {
            terms_agreed_directory: null,
            terms_agreed_at: null,
            terms_agreed_by: null,
            terms_url: null,
          };

      const values = {
        id: ROW_ID,
        contact_email: contactEmail,
        directory: input.directory,
        ...agreement,
        updated_at: now,
      };
      await kysely
        .insertInto('acme_settings')
        .values(values)
        .onDuplicateKeyUpdate({
          contact_email: values.contact_email,
          directory: values.directory,
          terms_agreed_directory: values.terms_agreed_directory,
          terms_agreed_at: values.terms_agreed_at,
          terms_agreed_by: values.terms_agreed_by,
          terms_url: values.terms_url,
          updated_at: values.updated_at,
        })
        .execute();
      return toSettings(values);
    },
  };
}

export type AcmeSettingsRepo = ReturnType<typeof createAcmeSettingsRepo>;
