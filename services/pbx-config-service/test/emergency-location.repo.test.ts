import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { crossTenantProbe, databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';

import { InvalidEmergencyLocationError } from '../src/domain/emergency-location.js';
import {
  EmergencyLocationInUseError,
  EmergencyLocationNotFoundError,
} from '../src/repo/emergency-location.repo.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());

describe.skipIf(skipReason !== undefined)('emergency location repo', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
  });

  function ctxFor(tenantId: string) {
    return { tenantId };
  }

  const VALID_INPUT = {
    label: 'Main Office',
    addressLine1: '123 Main St',
    city: 'Springfield',
    state: 'IL',
    postalCode: '62701',
    country: 'US',
  };

  it('creates a US location', async () => {
    const tenantId = crypto.randomUUID();
    const created = await h.emergencyLocations.create(ctxFor(tenantId), VALID_INPUT);
    expect(created).toMatchObject(VALID_INPUT);
    expect(created.addressLine2).toBeNull();
  });

  it('creates a Canadian location, uppercasing the postal code', async () => {
    const tenantId = crypto.randomUUID();
    const created = await h.emergencyLocations.create(ctxFor(tenantId), {
      label: 'Toronto Office',
      addressLine1: '1 Yonge St',
      city: 'Toronto',
      state: 'ON',
      postalCode: 'm5e 1e5',
      country: 'ca',
    });
    expect(created.country).toBe('CA');
    expect(created.postalCode).toBe('M5E 1E5');
  });

  it('rejects a country outside US/CA (G-1 v1 scope)', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.emergencyLocations.create(ctxFor(tenantId), { ...VALID_INPUT, country: 'GB' }),
    ).rejects.toThrow(InvalidEmergencyLocationError);
  });

  it('rejects a postal code that does not match the country format', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.emergencyLocations.create(ctxFor(tenantId), { ...VALID_INPUT, postalCode: 'not-a-zip' }),
    ).rejects.toThrow(InvalidEmergencyLocationError);
  });

  it('updates a location in place', async () => {
    const tenantId = crypto.randomUUID();
    const created = await h.emergencyLocations.create(ctxFor(tenantId), VALID_INPUT);
    const updated = await h.emergencyLocations.update(ctxFor(tenantId), created.id, {
      label: 'Main Office - 2nd Floor',
      addressLine2: 'Suite 200',
    });
    expect(updated).toMatchObject({
      label: 'Main Office - 2nd Floor',
      addressLine2: 'Suite 200',
      addressLine1: VALID_INPUT.addressLine1,
    });
  });

  it('404s updating a location that does not exist', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.emergencyLocations.update(ctxFor(tenantId), crypto.randomUUID(), { label: 'X' }),
    ).rejects.toThrow(EmergencyLocationNotFoundError);
  });

  it('404s removing a location that does not exist', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.emergencyLocations.remove(ctxFor(tenantId), crypto.randomUUID()),
    ).rejects.toThrow(EmergencyLocationNotFoundError);
  });

  it('refuses to remove a location still assigned to an extension', async () => {
    const tenantId = crypto.randomUUID();
    h.domains.realms[tenantId] = 'tenant-a.platform.test';
    const location = await h.emergencyLocations.create(ctxFor(tenantId), VALID_INPUT);
    await h.extensions.create(ctxFor(tenantId), {
      number: '101',
      displayName: 'Front Desk',
      emergencyLocationId: location.id,
    });

    await expect(h.emergencyLocations.remove(ctxFor(tenantId), location.id)).rejects.toThrow(
      EmergencyLocationInUseError,
    );
  });

  // 05 §2.4: every repository test suite includes a cross-tenant probe.
  crossTenantProbe({
    name: 'emergency_locations',
    seed: async (tenantId) => {
      const created = await h.emergencyLocations.create(ctxFor(tenantId), VALID_INPUT);
      return created.id;
    },
    list: (tenantId) => h.emergencyLocations.list(ctxFor(tenantId)),
    findById: (tenantId, id) => h.emergencyLocations.findById(ctxFor(tenantId), id),
    update: (tenantId, id) =>
      h.emergencyLocations
        .update(ctxFor(tenantId), id, { label: 'Renamed' })
        .then(() => 1)
        .catch((error: unknown) => {
          if (error instanceof EmergencyLocationNotFoundError) return 0;
          throw error;
        }),
    remove: (tenantId, id) =>
      h.emergencyLocations
        .remove(ctxFor(tenantId), id)
        .then(() => 1)
        .catch((error: unknown) => {
          if (error instanceof EmergencyLocationNotFoundError) return 0;
          throw error;
        }),
  });
});
