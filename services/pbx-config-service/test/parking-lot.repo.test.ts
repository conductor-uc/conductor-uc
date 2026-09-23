import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { crossTenantProbe, databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';

import { InvalidParkingLotError } from '../src/domain/parking-lot.js';
import {
  ParkingLotNotFoundError,
  ParkingLotSlotOverlapError,
} from '../src/repo/parking-lot.repo.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());

describe.skipIf(skipReason !== undefined)('parking lot repo', () => {
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

  it('creates a parking lot and enqueues pbx.parking_lot.created', async () => {
    const tenantId = crypto.randomUUID();

    const created = await h.parkingLots.create(ctxFor(tenantId), {
      label: 'Main Lot',
      slotStart: 700,
      slotEnd: 719,
      timeoutSeconds: 120,
    });

    expect(created).toMatchObject({
      label: 'Main Lot',
      slotStart: 700,
      slotEnd: 719,
      timeoutSeconds: 120,
      returnDestinationType: null,
      returnDestinationId: null,
    });

    const outboxRows = await h.db.kysely.selectFrom('outbox').selectAll().execute();
    expect(outboxRows.some((row) => row.type === 'pbx.parking_lot.created')).toBe(true);
  });

  it('accepts a return destination', async () => {
    const tenantId = crypto.randomUUID();
    const created = await h.parkingLots.create(ctxFor(tenantId), {
      label: 'Main Lot',
      slotStart: 700,
      slotEnd: 719,
      timeoutSeconds: 120,
      returnDestinationType: 'voicemail',
      returnDestinationId: crypto.randomUUID(),
    });
    expect(created.returnDestinationType).toBe('voicemail');
  });

  it('rejects slot_end before slot_start', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.parkingLots.create(ctxFor(tenantId), {
        label: 'Bad Lot',
        slotStart: 720,
        slotEnd: 700,
        timeoutSeconds: 120,
      }),
    ).rejects.toThrow(InvalidParkingLotError);
  });

  it('rejects a timeout out of range', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.parkingLots.create(ctxFor(tenantId), {
        label: 'Lot',
        slotStart: 700,
        slotEnd: 719,
        timeoutSeconds: 1,
      }),
    ).rejects.toThrow(InvalidParkingLotError);
  });

  it('rejects a lot whose slots overlap an existing lot in the same tenant', async () => {
    const tenantId = crypto.randomUUID();
    await h.parkingLots.create(ctxFor(tenantId), {
      label: 'Lot A',
      slotStart: 700,
      slotEnd: 719,
      timeoutSeconds: 120,
    });

    await expect(
      h.parkingLots.create(ctxFor(tenantId), {
        label: 'Lot B',
        slotStart: 710,
        slotEnd: 730,
        timeoutSeconds: 120,
      }),
    ).rejects.toThrow(ParkingLotSlotOverlapError);
  });

  it('allows overlapping slot ranges across different tenants', async () => {
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();
    await h.parkingLots.create(ctxFor(tenantA), {
      label: 'Lot A',
      slotStart: 700,
      slotEnd: 719,
      timeoutSeconds: 120,
    });

    const created = await h.parkingLots.create(ctxFor(tenantB), {
      label: 'Lot B',
      slotStart: 700,
      slotEnd: 719,
      timeoutSeconds: 120,
    });
    expect(created.slotStart).toBe(700);
  });

  it('updates a lot, bumping version and enqueueing pbx.parking_lot.updated', async () => {
    const tenantId = crypto.randomUUID();
    const created = await h.parkingLots.create(ctxFor(tenantId), {
      label: 'Lot',
      slotStart: 700,
      slotEnd: 719,
      timeoutSeconds: 120,
    });

    const updated = await h.parkingLots.update(ctxFor(tenantId), created.id, {
      timeoutSeconds: 60,
    });
    expect(updated.timeoutSeconds).toBe(60);

    const outboxRows = await h.db.kysely.selectFrom('outbox').selectAll().execute();
    expect(outboxRows.some((row) => row.type === 'pbx.parking_lot.updated')).toBe(true);
  });

  it('allows updating a lot to overlap its own previous range (excludes itself)', async () => {
    const tenantId = crypto.randomUUID();
    const created = await h.parkingLots.create(ctxFor(tenantId), {
      label: 'Lot',
      slotStart: 700,
      slotEnd: 719,
      timeoutSeconds: 120,
    });

    const updated = await h.parkingLots.update(ctxFor(tenantId), created.id, {
      slotStart: 705,
      slotEnd: 725,
    });
    expect(updated.slotStart).toBe(705);
  });

  it('rejects updating a lot to overlap a different lot', async () => {
    const tenantId = crypto.randomUUID();
    await h.parkingLots.create(ctxFor(tenantId), {
      label: 'Lot A',
      slotStart: 700,
      slotEnd: 719,
      timeoutSeconds: 120,
    });
    const lotB = await h.parkingLots.create(ctxFor(tenantId), {
      label: 'Lot B',
      slotStart: 800,
      slotEnd: 819,
      timeoutSeconds: 120,
    });

    await expect(
      h.parkingLots.update(ctxFor(tenantId), lotB.id, { slotStart: 710, slotEnd: 730 }),
    ).rejects.toThrow(ParkingLotSlotOverlapError);
  });

  it('throws ParkingLotNotFoundError updating a missing lot', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.parkingLots.update(ctxFor(tenantId), crypto.randomUUID(), { label: 'x' }),
    ).rejects.toThrow(ParkingLotNotFoundError);
  });

  it('deletes a lot and enqueues pbx.parking_lot.deleted', async () => {
    const tenantId = crypto.randomUUID();
    const created = await h.parkingLots.create(ctxFor(tenantId), {
      label: 'Lot',
      slotStart: 700,
      slotEnd: 719,
      timeoutSeconds: 120,
    });

    await h.parkingLots.remove(ctxFor(tenantId), created.id);
    expect(await h.parkingLots.findById(ctxFor(tenantId), created.id)).toBeUndefined();

    const outboxRows = await h.db.kysely.selectFrom('outbox').selectAll().execute();
    expect(outboxRows.some((row) => row.type === 'pbx.parking_lot.deleted')).toBe(true);
  });

  it('throws ParkingLotNotFoundError deleting a missing lot', async () => {
    const tenantId = crypto.randomUUID();
    await expect(h.parkingLots.remove(ctxFor(tenantId), crypto.randomUUID())).rejects.toThrow(
      ParkingLotNotFoundError,
    );
  });

  crossTenantProbe({
    name: 'parking_lots',
    seed: async (tenantId) => {
      const created = await h.parkingLots.create(ctxFor(tenantId), {
        label: 'Lot',
        slotStart: 700,
        slotEnd: 719,
        timeoutSeconds: 120,
      });
      return created.id;
    },
    list: (tenantId) => h.parkingLots.list(ctxFor(tenantId)),
    findById: (tenantId, id) => h.parkingLots.findById(ctxFor(tenantId), id),
    remove: (tenantId, id) =>
      h.parkingLots
        .remove(ctxFor(tenantId), id)
        .then(() => 1)
        .catch((error: unknown) => {
          if (error instanceof ParkingLotNotFoundError) return 0;
          throw error;
        }),
  });
});
