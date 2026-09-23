import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { crossTenantProbe, databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';

import { InvalidConferenceRoomError } from '../src/domain/conference-room.js';
import {
  ConferenceRoomNotFoundError,
  ConferenceRoomNumberTakenError,
} from '../src/repo/conference-room.repo.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());

describe.skipIf(skipReason !== undefined)('conference room repo', () => {
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

  it('creates a conference room and enqueues pbx.conference_room.created', async () => {
    const tenantId = crypto.randomUUID();

    const created = await h.conferenceRooms.create(ctxFor(tenantId), {
      label: 'All Hands',
      number: '600',
      maxMembers: 50,
    });

    expect(created).toMatchObject({
      label: 'All Hands',
      number: '600',
      pinRequired: false,
      video: false,
      layout: null,
      maxMembers: 50,
    });

    const outboxRows = await h.db.kysely.selectFrom('outbox').selectAll().execute();
    expect(outboxRows.some((row) => row.type === 'pbx.conference_room.created')).toBe(true);
  });

  it('never stores the PIN in plaintext', async () => {
    const tenantId = crypto.randomUUID();
    const created = await h.conferenceRooms.create(ctxFor(tenantId), {
      label: 'Board Room',
      number: '601',
      pin: '1234',
      maxMembers: 10,
    });
    expect(created.pinRequired).toBe(true);

    const row = await h.db.kysely
      .selectFrom('conference_rooms')
      .select('pin_enc')
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(row.pin_enc).not.toBeNull();
    expect(row.pin_enc).not.toContain('1234');
  });

  it('verifies a correct PIN and rejects a wrong one', async () => {
    const tenantId = crypto.randomUUID();
    const created = await h.conferenceRooms.create(ctxFor(tenantId), {
      label: 'Board Room',
      number: '601',
      pin: '1234',
      maxMembers: 10,
    });

    expect(await h.conferenceRooms.verifyPin(ctxFor(tenantId), created.id, '1234')).toBe(true);
    expect(await h.conferenceRooms.verifyPin(ctxFor(tenantId), created.id, '9999')).toBe(false);
  });

  it('rejects verifying a PIN on a room with none set', async () => {
    const tenantId = crypto.randomUUID();
    const created = await h.conferenceRooms.create(ctxFor(tenantId), {
      label: 'Open Room',
      number: '602',
      maxMembers: 10,
    });

    expect(await h.conferenceRooms.verifyPin(ctxFor(tenantId), created.id, '1234')).toBe(false);
  });

  it('rejects a malformed PIN', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.conferenceRooms.create(ctxFor(tenantId), {
        label: 'Bad PIN',
        number: '603',
        pin: 'abcd',
        maxMembers: 10,
      }),
    ).rejects.toThrow(InvalidConferenceRoomError);
  });

  it('rejects a malformed number', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.conferenceRooms.create(ctxFor(tenantId), {
        label: 'Bad Number',
        number: 'abc',
        maxMembers: 10,
      }),
    ).rejects.toThrow(InvalidConferenceRoomError);
  });

  it('rejects max_members out of range', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.conferenceRooms.create(ctxFor(tenantId), {
        label: 'Too Big',
        number: '604',
        maxMembers: 1,
      }),
    ).rejects.toThrow(InvalidConferenceRoomError);
  });

  it('rejects a room number already used by another room in the same tenant', async () => {
    const tenantId = crypto.randomUUID();
    await h.conferenceRooms.create(ctxFor(tenantId), {
      label: 'Room A',
      number: '605',
      maxMembers: 10,
    });

    await expect(
      h.conferenceRooms.create(ctxFor(tenantId), {
        label: 'Room B',
        number: '605',
        maxMembers: 10,
      }),
    ).rejects.toThrow(ConferenceRoomNumberTakenError);
  });

  it('allows the same room number across different tenants', async () => {
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();
    await h.conferenceRooms.create(ctxFor(tenantA), {
      label: 'Room A',
      number: '606',
      maxMembers: 10,
    });

    const created = await h.conferenceRooms.create(ctxFor(tenantB), {
      label: 'Room B',
      number: '606',
      maxMembers: 10,
    });
    expect(created.number).toBe('606');
  });

  it('updates a room, bumping version and enqueueing pbx.conference_room.updated', async () => {
    const tenantId = crypto.randomUUID();
    const created = await h.conferenceRooms.create(ctxFor(tenantId), {
      label: 'Room',
      number: '607',
      maxMembers: 10,
    });

    const updated = await h.conferenceRooms.update(ctxFor(tenantId), created.id, {
      maxMembers: 25,
    });
    expect(updated.maxMembers).toBe(25);

    const outboxRows = await h.db.kysely.selectFrom('outbox').selectAll().execute();
    expect(outboxRows.some((row) => row.type === 'pbx.conference_room.updated')).toBe(true);
  });

  it('can set a PIN on update, and later clear it', async () => {
    const tenantId = crypto.randomUUID();
    const created = await h.conferenceRooms.create(ctxFor(tenantId), {
      label: 'Room',
      number: '608',
      maxMembers: 10,
    });
    expect(created.pinRequired).toBe(false);

    const withPin = await h.conferenceRooms.update(ctxFor(tenantId), created.id, { pin: '4321' });
    expect(withPin.pinRequired).toBe(true);
    expect(await h.conferenceRooms.verifyPin(ctxFor(tenantId), created.id, '4321')).toBe(true);

    const withoutPin = await h.conferenceRooms.update(ctxFor(tenantId), created.id, { pin: null });
    expect(withoutPin.pinRequired).toBe(false);
  });

  it('rejects updating a room to a number already used by another room', async () => {
    const tenantId = crypto.randomUUID();
    await h.conferenceRooms.create(ctxFor(tenantId), {
      label: 'Room A',
      number: '609',
      maxMembers: 10,
    });
    const roomB = await h.conferenceRooms.create(ctxFor(tenantId), {
      label: 'Room B',
      number: '610',
      maxMembers: 10,
    });

    await expect(
      h.conferenceRooms.update(ctxFor(tenantId), roomB.id, { number: '609' }),
    ).rejects.toThrow(ConferenceRoomNumberTakenError);
  });

  it('throws ConferenceRoomNotFoundError updating a missing room', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.conferenceRooms.update(ctxFor(tenantId), crypto.randomUUID(), { label: 'x' }),
    ).rejects.toThrow(ConferenceRoomNotFoundError);
  });

  it('deletes a room and enqueues pbx.conference_room.deleted', async () => {
    const tenantId = crypto.randomUUID();
    const created = await h.conferenceRooms.create(ctxFor(tenantId), {
      label: 'Room',
      number: '611',
      maxMembers: 10,
    });

    await h.conferenceRooms.remove(ctxFor(tenantId), created.id);
    expect(await h.conferenceRooms.findById(ctxFor(tenantId), created.id)).toBeUndefined();

    const outboxRows = await h.db.kysely.selectFrom('outbox').selectAll().execute();
    expect(outboxRows.some((row) => row.type === 'pbx.conference_room.deleted')).toBe(true);
  });

  it('throws ConferenceRoomNotFoundError deleting a missing room', async () => {
    const tenantId = crypto.randomUUID();
    await expect(h.conferenceRooms.remove(ctxFor(tenantId), crypto.randomUUID())).rejects.toThrow(
      ConferenceRoomNotFoundError,
    );
  });

  crossTenantProbe({
    name: 'conference_rooms',
    seed: async (tenantId) => {
      const created = await h.conferenceRooms.create(ctxFor(tenantId), {
        label: 'Room',
        number: '612',
        maxMembers: 10,
      });
      return created.id;
    },
    list: (tenantId) => h.conferenceRooms.list(ctxFor(tenantId)),
    findById: (tenantId, id) => h.conferenceRooms.findById(ctxFor(tenantId), id),
    remove: (tenantId, id) =>
      h.conferenceRooms
        .remove(ctxFor(tenantId), id)
        .then(() => 1)
        .catch((error: unknown) => {
          if (error instanceof ConferenceRoomNotFoundError) return 0;
          throw error;
        }),
  });
});
