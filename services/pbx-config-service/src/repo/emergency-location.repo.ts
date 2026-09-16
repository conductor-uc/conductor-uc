import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { requireTenant } from '@cuc/db';

import {
  validateAddressLine1,
  validateAddressLine2,
  validateCity,
  validateCountry,
  validateLabel,
  validatePostalCode,
  validateState,
  type EmergencyLocationCountry,
} from '../domain/emergency-location.js';
import type { PbxConfigServiceDb } from '../schema.js';

export interface EmergencyLocation {
  readonly id: string;
  readonly tenantId: string;
  readonly label: string;
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  readonly country: EmergencyLocationCountry;
}

export interface CreateEmergencyLocationInput {
  readonly label: string;
  readonly addressLine1: string;
  readonly addressLine2?: string | null;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  readonly country: string;
}

export type UpdateEmergencyLocationInput = Partial<CreateEmergencyLocationInput>;

export class EmergencyLocationNotFoundError extends Error {
  override readonly name = 'EmergencyLocationNotFoundError';
}

/**
 * Set on an `extensions` row that still names a real `emergency_locations`
 * row — a location cannot be deleted out from under an extension still
 * pointing at it (issue #96: dispatchable location is required, not
 * advisory, so silently leaving an extension with a dangling reference
 * would defeat the whole point).
 */
export class EmergencyLocationInUseError extends Error {
  override readonly name = 'EmergencyLocationInUseError';
}

const COLUMNS = [
  'id',
  'tenant_id as tenantId',
  'label',
  'address_line1 as addressLine1',
  'address_line2 as addressLine2',
  'city',
  'state',
  'postal_code as postalCode',
  'country',
] as const;

function toLocation(row: {
  id: string;
  tenantId: string;
  label: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}): EmergencyLocation {
  return { ...row, country: row.country as EmergencyLocationCountry };
}

/**
 * Data access for dispatchable emergency locations (S2-06; 05 §3.3, G-1).
 * Every query goes through `scoped(ctx)` (CLAUDE.md rule 2). Deliberately
 * has no `enqueueEvent` calls at all — nothing outside this service needs
 * to react to a location changing; telephony-config fetches one live, at
 * the moment an emergency call actually needs it
 * (`org-client.ts`'s own S2-05 precedent for why a live fetch beats a
 * cached mirror for data that must reflect the very latest write).
 */
export function createEmergencyLocationRepo(db: Database<PbxConfigServiceDb>) {
  return {
    list: (ctx: DbContext): Promise<EmergencyLocation[]> =>
      db
        .scoped(ctx)
        .selectFrom('emergency_locations')
        .select(COLUMNS)
        .orderBy('label', 'asc')
        .execute()
        .then((rows) => rows.map(toLocation)),

    findById: (ctx: DbContext, id: string): Promise<EmergencyLocation | undefined> =>
      db
        .scoped(ctx)
        .selectFrom('emergency_locations')
        .select(COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : toLocation(row))),

    async create(ctx: DbContext, input: CreateEmergencyLocationInput): Promise<EmergencyLocation> {
      const { tenantId } = requireTenant(ctx);
      const country = validateCountry(input.country);
      const location: EmergencyLocation = {
        id: randomUUID(),
        tenantId,
        label: validateLabel(input.label),
        addressLine1: validateAddressLine1(input.addressLine1),
        addressLine2: validateAddressLine2(input.addressLine2),
        city: validateCity(input.city),
        state: validateState(input.state),
        postalCode: validatePostalCode(country, input.postalCode),
        country,
      };
      const now = new Date();
      await db
        .scoped(ctx)
        .insertInto('emergency_locations')
        .values({
          id: location.id,
          label: location.label,
          address_line1: location.addressLine1,
          address_line2: location.addressLine2,
          city: location.city,
          state: location.state,
          postal_code: location.postalCode,
          country: location.country,
          created_at: now,
          updated_at: now,
          version: 1,
        })
        .execute();
      return location;
    },

    async update(
      ctx: DbContext,
      id: string,
      input: UpdateEmergencyLocationInput,
    ): Promise<EmergencyLocation> {
      const existing = await db
        .scoped(ctx)
        .selectFrom('emergency_locations')
        .select(COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing === undefined) {
        throw new EmergencyLocationNotFoundError(`No emergency location with id '${id}'.`);
      }

      const country = validateCountry(input.country ?? existing.country);
      const merged: EmergencyLocation = {
        ...existing,
        country,
        label: input.label === undefined ? existing.label : validateLabel(input.label),
        addressLine1:
          input.addressLine1 === undefined
            ? existing.addressLine1
            : validateAddressLine1(input.addressLine1),
        addressLine2:
          input.addressLine2 === undefined
            ? existing.addressLine2
            : validateAddressLine2(input.addressLine2),
        city: input.city === undefined ? existing.city : validateCity(input.city),
        state: input.state === undefined ? existing.state : validateState(input.state),
        postalCode:
          input.postalCode === undefined
            ? validatePostalCode(country, existing.postalCode)
            : validatePostalCode(country, input.postalCode),
      };

      await db
        .scoped(ctx)
        .updateTable('emergency_locations')
        .set({
          label: merged.label,
          address_line1: merged.addressLine1,
          address_line2: merged.addressLine2,
          city: merged.city,
          state: merged.state,
          postal_code: merged.postalCode,
          country: merged.country,
          updated_at: new Date(),
        })
        .where('id', '=', id)
        .execute();

      return merged;
    },

    async remove(ctx: DbContext, id: string): Promise<void> {
      const inUse = await db
        .scoped(ctx)
        .selectFrom('extensions')
        .select('id')
        .where('emergency_location_id', '=', id)
        .executeTakeFirst();
      if (inUse !== undefined) {
        throw new EmergencyLocationInUseError(
          `Emergency location '${id}' is still assigned to at least one extension.`,
        );
      }

      const result = await db
        .scoped(ctx)
        .deleteFrom('emergency_locations')
        .where('id', '=', id)
        .executeTakeFirst();
      if (Number(result.numDeletedRows) === 0) {
        throw new EmergencyLocationNotFoundError(`No emergency location with id '${id}'.`);
      }
    },
  };
}

export type EmergencyLocationRepo = ReturnType<typeof createEmergencyLocationRepo>;
