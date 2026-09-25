import { randomUUID } from 'node:crypto';

import type { Database, DbContext, Transaction } from '@cuc/db';
import { isDuplicateKeyError, requireTenant, scopedFor } from '@cuc/db';
import type { KekProvider } from '@cuc/crypto';
import { decryptString, encrypt } from '@cuc/crypto';
import { enqueueEvent } from '@cuc/events';

import {
  assertNumberAvailable,
  ExtensionNumberTakenError,
  validateExtensionNumber,
} from '../domain/numbering.js';
import { computeSipDigest, generateSipPassword } from '../domain/sip-credentials.js';
import { pbxEvents } from '../events.js';
import type { TenantDomainLookup } from '../org-client.js';
import type { PbxConfigServiceDb } from '../schema.js';

export interface Extension {
  readonly id: string;
  readonly tenantId: string;
  readonly number: string;
  readonly userId: string | null;
  readonly displayName: string;
  readonly callerIdName: string | null;
  readonly callerIdNumber: string | null;
  readonly voicemailEnabled: boolean;
  /** A `emergency_locations` row in this tenant (S2-06; G-1) — required, never null. */
  readonly emergencyLocationId: string;
}

export interface CreateExtensionInput {
  readonly number: string;
  readonly userId?: string | null;
  readonly displayName: string;
  readonly callerIdName?: string | null;
  readonly callerIdNumber?: string | null;
  readonly voicemailEnabled?: boolean;
  /** Required (issue #96: "an extension cannot go live without one") — not optional the way the caller-ID fields are. */
  readonly emergencyLocationId: string;
}

export interface UpdateExtensionInput {
  readonly number?: string;
  readonly userId?: string | null;
  readonly displayName?: string;
  readonly callerIdName?: string | null;
  readonly callerIdNumber?: string | null;
  readonly voicemailEnabled?: boolean;
  readonly emergencyLocationId?: string;
}

/** What `:reveal` returns — the one place the plaintext password ever leaves this service. */
export interface RevealedCredential {
  readonly username: string;
  readonly password: string;
  readonly realm: string;
}

/**
 * What telephony-config's internal lookup returns (S1-12) — the digest
 * material OpenSIPs' `subscriber` table needs, never the plaintext password
 * this service never hands to anything but `:reveal`.
 *
 * `number` is included alongside the SIP `username` (S1-13): they start
 * equal at creation but can diverge — `update()` below never touches
 * `sip_credentials.username` when `number` (the dialable extension) is
 * renumbered. telephony-config's `/fs/dialplan` needs the *current* number
 * for ext→ext lookups, which `username` alone cannot answer.
 */
export interface DigestCredential {
  readonly extensionId: string;
  readonly number: string;
  readonly username: string;
  readonly ha1: string;
  readonly ha1b: string;
  readonly realm: string;
  /** The extension's own caller-ID override (S2-04's own precedence: extension, then a bound DID, then the trunk's policy). */
  readonly callerIdName: string | null;
  readonly callerIdNumber: string | null;
  /** S2-06 (G-1) — what `/fs/dialplan`'s emergency branch resolves to a real address via `GET /internal/v1/tenants/:id/emergency-locations/:id`. */
  readonly emergencyLocationId: string;
}

export class ExtensionNotFoundError extends Error {
  override readonly name = 'ExtensionNotFoundError';
}

/** S2-06 (G-1): `emergencyLocationId` must name a real `emergency_locations` row in the same tenant. */
export class EmergencyLocationNotFoundError extends Error {
  override readonly name = 'EmergencyLocationNotFoundError';
}

export class TenantDomainNotFoundError extends Error {
  override readonly name = 'TenantDomainNotFoundError';

  constructor(tenantId: string) {
    super(
      `Tenant '${tenantId}' has no primary SIP domain yet — SIP credentials cannot be generated ` +
        'without a realm.',
    );
  }
}

export { ExtensionNumberTakenError };

function associatedData(tenantId: string, credentialId: string): string {
  return `${tenantId}:sip_credentials.secret_enc:${credentialId}`;
}

interface ExtensionRow {
  id: string;
  tenant_id: string;
  number: string;
  user_id: string | null;
  display_name: string;
  caller_id_name: string | null;
  caller_id_number: string | null;
  voicemail_enabled: boolean;
  emergency_location_id: string;
}

/**
 * A `toExtension` input can also be a fresh row straight off the wire, where
 * mysql2 hands MariaDB's `TINYINT(1)` back as a JS number rather than the
 * `boolean` Kysely's schema types it as (the same surprise org-service's
 * `domain.repo.ts` hit) — hence the wider `voicemail_enabled` type here,
 * narrowed with `Boolean(...)` below rather than trusted as already-boolean.
 */
function toExtension(
  row: Omit<ExtensionRow, 'voicemail_enabled'> & {
    voicemail_enabled: boolean | number;
  },
): Extension {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    number: row.number,
    userId: row.user_id,
    displayName: row.display_name,
    callerIdName: row.caller_id_name,
    callerIdNumber: row.caller_id_number,
    voicemailEnabled: Boolean(row.voicemail_enabled),
    emergencyLocationId: row.emergency_location_id,
  };
}

/**
 * Data access for extensions and their SIP credentials (S1-09; 05 §3.3).
 *
 * Every query goes through `scoped(ctx)` (CLAUDE.md rule 2). A credential's
 * plaintext password exists only for the instant `create` or `reveal`
 * computes it — never logged, never returned from anything but those two
 * paths, and `secret_enc` is envelope-encrypted at rest (07 §5).
 */
export function createExtensionRepo(
  db: Database<PbxConfigServiceDb>,
  domains: TenantDomainLookup,
  kek: KekProvider,
) {
  return {
    list: (ctx: DbContext): Promise<Extension[]> =>
      db
        .scoped(ctx)
        .selectFrom('extensions')
        .selectAll()
        .orderBy('number', 'asc')
        .execute()
        .then((rows) => rows.map(toExtension)),

    findById: (ctx: DbContext, id: string): Promise<Extension | undefined> =>
      db
        .scoped(ctx)
        .selectFrom('extensions')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : toExtension(row))),

    /**
     * Creates the extension and its SIP credentials in one transaction
     * (CLAUDE.md rule 6): the realm is looked up from org-service first
     * (outside the transaction — it is a read from another service, not a
     * row this transaction could roll back anyway), then the extension row,
     * the credentials row, and the `pbx.extension.created` event all commit
     * together or not at all.
     */
    async create(ctx: DbContext, input: CreateExtensionInput): Promise<Extension> {
      const number = validateExtensionNumber(input.number);
      const { tenantId } = requireTenant(ctx);

      const realm = await domains(tenantId);
      if (realm === undefined) throw new TenantDomainNotFoundError(tenantId);

      const location = await db
        .scoped(ctx)
        .selectFrom('emergency_locations')
        .select('id')
        .where('id', '=', input.emergencyLocationId)
        .executeTakeFirst();
      if (location === undefined) {
        throw new EmergencyLocationNotFoundError(
          `No emergency location with id '${input.emergencyLocationId}' in this tenant.`,
        );
      }

      const id = randomUUID();
      const now = new Date();
      const password = generateSipPassword();
      const digest = computeSipDigest(number, realm, password);
      const credentialId = randomUUID();
      const secretEnc = await encrypt(kek, password, associatedData(tenantId, credentialId));

      const userId = input.userId ?? null;
      const callerIdName = input.callerIdName ?? null;
      const callerIdNumber = input.callerIdNumber ?? null;
      const voicemailEnabled = input.voicemailEnabled ?? false;

      try {
        await db.scoped(ctx).transaction(async (trx, raw) => {
          await trx
            .insertInto('extensions')
            .values({
              id,
              number,
              user_id: userId,
              display_name: input.displayName,
              caller_id_name: callerIdName,
              caller_id_number: callerIdNumber,
              voicemail_enabled: voicemailEnabled,
              emergency_location_id: input.emergencyLocationId,
              created_at: now,
              updated_at: now,
              version: 1,
            })
            .execute();

          await trx
            .insertInto('sip_credentials')
            .values({
              id: credentialId,
              extension_id: id,
              username: number,
              secret_enc: secretEnc,
              ha1: digest.ha1,
              ha1b: digest.ha1b,
              realm,
              created_at: now,
              updated_at: now,
            })
            .execute();

          await enqueueEvent(raw, pbxEvents, {
            type: 'pbx.extension.created',
            data: { extensionId: id, number, displayName: input.displayName },
            orgContext: { tenantId },
            ...(ctx.actorId === undefined || ctx.orgId === undefined
              ? {}
              : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
            ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
          });
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) throw new ExtensionNumberTakenError(number);
        throw error;
      }

      return {
        id,
        tenantId,
        number,
        userId,
        displayName: input.displayName,
        callerIdName,
        callerIdNumber,
        voicemailEnabled,
        emergencyLocationId: input.emergencyLocationId,
      };
    },

    /**
     * Updates the extension's own fields. Never touches `sip_credentials`,
     * even when `number` changes — the SIP username a device already
     * registered with does not change just because the dialable number does
     * (`domain/sip-credentials.ts`).
     */
    async update(ctx: DbContext, id: string, input: UpdateExtensionInput): Promise<Extension> {
      const { tenantId } = requireTenant(ctx);
      const existing = await db
        .scoped(ctx)
        .selectFrom('extensions')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing === undefined) throw new ExtensionNotFoundError(`No extension with id '${id}'.`);

      const number =
        input.number === undefined ? existing.number : validateExtensionNumber(input.number);
      if (number !== existing.number) {
        const taken = await db
          .scoped(ctx)
          .selectFrom('extensions')
          .select('id')
          .where('number', '=', number)
          .executeTakeFirst();
        assertNumberAvailable(number, taken !== undefined);
      }

      if (
        input.emergencyLocationId !== undefined &&
        input.emergencyLocationId !== existing.emergency_location_id
      ) {
        const location = await db
          .scoped(ctx)
          .selectFrom('emergency_locations')
          .select('id')
          .where('id', '=', input.emergencyLocationId)
          .executeTakeFirst();
        if (location === undefined) {
          throw new EmergencyLocationNotFoundError(
            `No emergency location with id '${input.emergencyLocationId}' in this tenant.`,
          );
        }
      }

      const merged: ExtensionRow = {
        id: existing.id,
        tenant_id: existing.tenant_id,
        number,
        user_id: input.userId === undefined ? existing.user_id : input.userId,
        display_name: input.displayName ?? existing.display_name,
        caller_id_name:
          input.callerIdName === undefined ? existing.caller_id_name : input.callerIdName,
        caller_id_number:
          input.callerIdNumber === undefined ? existing.caller_id_number : input.callerIdNumber,
        voicemail_enabled: input.voicemailEnabled ?? Boolean(existing.voicemail_enabled),
        emergency_location_id: input.emergencyLocationId ?? existing.emergency_location_id,
      };

      try {
        await db.scoped(ctx).transaction(async (trx, raw) => {
          await trx
            .updateTable('extensions')
            .set({
              number: merged.number,
              user_id: merged.user_id,
              display_name: merged.display_name,
              caller_id_name: merged.caller_id_name,
              caller_id_number: merged.caller_id_number,
              voicemail_enabled: merged.voicemail_enabled,
              emergency_location_id: merged.emergency_location_id,
              updated_at: new Date(),
              version: existing.version + 1,
            })
            .where('id', '=', id)
            .execute();

          await enqueueEvent(raw, pbxEvents, {
            type: 'pbx.extension.updated',
            data: { extensionId: id },
            orgContext: { tenantId },
            ...(ctx.actorId === undefined || ctx.orgId === undefined
              ? {}
              : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
            ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
          });
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) throw new ExtensionNumberTakenError(number);
        throw error;
      }

      return toExtension(merged);
    },

    async remove(ctx: DbContext, id: string): Promise<void> {
      const { tenantId } = requireTenant(ctx);

      await db.scoped(ctx).transaction(async (trx, raw) => {
        // A phone provisioned for this extension has nothing left to sign in to.
        await trx.deleteFrom('devices').where('extension_id', '=', id).execute();
        await trx.deleteFrom('extension_call_handling').where('extension_id', '=', id).execute();
        await trx.deleteFrom('sip_credentials').where('extension_id', '=', id).execute();
        const result = await trx.deleteFrom('extensions').where('id', '=', id).executeTakeFirst();
        if (Number(result.numDeletedRows) === 0) {
          throw new ExtensionNotFoundError(`No extension with id '${id}'.`);
        }

        await enqueueEvent(raw, pbxEvents, {
          type: 'pbx.extension.deleted',
          data: { extensionId: id },
          orgContext: { tenantId },
          ...(ctx.actorId === undefined || ctx.orgId === undefined
            ? {}
            : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });
    },

    /**
     * Decrypts and returns the SIP password (06: "never returned after
     * creation except through a `:reveal` action that requires a permission
     * and is audited"). Auditing itself is the route's job — it has the bus
     * and the request's ip/reason, which this repository does not.
     */
    async reveal(ctx: DbContext, extensionId: string): Promise<RevealedCredential> {
      const credential = await db
        .scoped(ctx)
        .selectFrom('sip_credentials')
        .selectAll()
        .where('extension_id', '=', extensionId)
        .executeTakeFirst();
      if (credential === undefined) {
        throw new ExtensionNotFoundError(`No extension with id '${extensionId}'.`);
      }

      const password = await decryptString(
        kek,
        credential.secret_enc,
        associatedData(credential.tenant_id, credential.id),
      );
      return { username: credential.username, password, realm: credential.realm };
    },

    /**
     * Replaces an extension's SIP password with a new random one and returns it.
     * The old password stops working the moment OpenSIPs picks up the change,
     * which the `pbx.extension.updated` event queued in the same transaction
     * makes telephony-config project (it re-reads the credential's digests).
     *
     * The realm and username are kept as stored. Only the secret and the two
     * digests derived from it change. Auditing is the route's job, as for
     * `reveal`.
     */
    async resetPassword(ctx: DbContext, extensionId: string): Promise<RevealedCredential> {
      const { tenantId } = requireTenant(ctx);
      const credential = await db
        .scoped(ctx)
        .selectFrom('sip_credentials')
        .selectAll()
        .where('extension_id', '=', extensionId)
        .executeTakeFirst();
      if (credential === undefined) {
        throw new ExtensionNotFoundError(`No extension with id '${extensionId}'.`);
      }

      const password = generateSipPassword();
      const digest = computeSipDigest(credential.username, credential.realm, password);
      const secretEnc = await encrypt(kek, password, associatedData(tenantId, credential.id));

      await db.scoped(ctx).transaction(async (trx, raw) => {
        await trx
          .updateTable('sip_credentials')
          .set({
            secret_enc: secretEnc,
            ha1: digest.ha1,
            ha1b: digest.ha1b,
            updated_at: new Date(),
          })
          .where('id', '=', credential.id)
          .execute();

        await enqueueEvent(raw, pbxEvents, {
          type: 'pbx.extension.updated',
          data: { extensionId },
          orgContext: { tenantId },
          ...(ctx.actorId === undefined || ctx.orgId === undefined
            ? {}
            : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });
      });

      return { username: credential.username, password, realm: credential.realm };
    },

    /**
     * The digest material for one extension's credential — what
     * telephony-config's `GET /internal/v1/tenants/:tenantId/extensions/:id`
     * (S1-12) returns to project into OpenSIPs' `subscriber` table. Unlike
     * `reveal`, this never touches the KEK: `ha1`/`ha1b` are stored
     * unencrypted already (auth_db needs to read them as-is), only the
     * plaintext password is ever encrypted.
     */
    async findCredential(
      ctx: DbContext,
      extensionId: string,
    ): Promise<DigestCredential | undefined> {
      const { tenantId } = requireTenant(ctx);
      const credential = await db
        .scoped(ctx)
        .selectFrom('sip_credentials')
        .innerJoin('extensions', 'extensions.id', 'sip_credentials.extension_id')
        .select([
          'sip_credentials.username',
          'sip_credentials.ha1',
          'sip_credentials.ha1b',
          'sip_credentials.realm',
          'extensions.number',
          'extensions.caller_id_name as callerIdName',
          'extensions.caller_id_number as callerIdNumber',
          'extensions.emergency_location_id as emergencyLocationId',
        ])
        // Belt-and-suspenders alongside `scoped(ctx)`'s own filter on
        // `sip_credentials.tenant_id`: both rows are already guaranteed the
        // same tenant by `extension_id`'s FK, but an explicit predicate on
        // the joined table costs nothing (CLAUDE.md rule 2).
        .where('extensions.tenant_id', '=', tenantId)
        .where('sip_credentials.extension_id', '=', extensionId)
        .executeTakeFirst();
      if (credential === undefined) return undefined;
      return { extensionId, ...credential };
    },

    /**
     * Recomputes HA1/HA1B for every credential in `tenantId` under
     * `newRealm` (02 §3). Called from `consumers/domain.consumer.ts` when
     * org-service's `org.domain.added` fires for that tenant, on the same
     * transaction the consumer records `consumed_events` in — this is a
     * handler's whole unit of work, not a standalone repo call, so it takes
     * that transaction rather than opening its own (`@cuc/events`' contract:
     * the handler's work and its dedupe record commit together). The secret
     * itself is unchanged — only the realm and the two digests, which are
     * derived from it, are.
     *
     * Returns how many rows were recomputed, so the consumer can log it.
     */
    async recomputeForDomainChange(
      trx: Transaction<PbxConfigServiceDb>,
      tenantId: string,
      newRealm: string,
    ): Promise<number> {
      const scoped = scopedFor(trx, { tenantId });
      const rows = await scoped.selectFrom('sip_credentials').selectAll().execute();

      let recomputed = 0;
      for (const row of rows) {
        if (row.realm === newRealm) continue;

        const password = await decryptString(kek, row.secret_enc, associatedData(tenantId, row.id));
        const digest = computeSipDigest(row.username, newRealm, password);

        await scoped
          .updateTable('sip_credentials')
          .set({ ha1: digest.ha1, ha1b: digest.ha1b, realm: newRealm, updated_at: new Date() })
          .where('id', '=', row.id)
          .execute();
        recomputed += 1;
      }

      return recomputed;
    },
  };
}

export type ExtensionRepo = ReturnType<typeof createExtensionRepo>;
