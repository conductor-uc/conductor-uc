import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { crossTenantProbe, databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';

import { InvalidRingGroupError } from '../src/domain/ring-group.js';
import {
  RingGroupMemberNotFoundError,
  RingGroupNotFoundError,
} from '../src/repo/ring-group.repo.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());

describe.skipIf(skipReason !== undefined)('ring group repo', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
    h.domains.realms = {};
  });

  function ctxFor(tenantId: string) {
    return { tenantId };
  }

  async function createExtension(tenantId: string, number: string): Promise<string> {
    h.domains.realms[tenantId] ??= `${tenantId}.platform.test`;
    const location = await h.emergencyLocations.create(ctxFor(tenantId), {
      label: 'Test Location',
      addressLine1: '123 Main St',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      country: 'US',
    });
    const extension = await h.extensions.create(ctxFor(tenantId), {
      number,
      displayName: `Extension ${number}`,
      emergencyLocationId: location.id,
    });
    return extension.id;
  }

  it('creates a ring group and enqueues pbx.ring_group.created', async () => {
    const tenantId = crypto.randomUUID();
    const ext1 = await createExtension(tenantId, '101');
    const ext2 = await createExtension(tenantId, '102');

    const created = await h.ringGroups.create(ctxFor(tenantId), {
      label: 'Sales',
      strategy: 'simultaneous',
      memberExtensionIds: [ext1, ext2],
      ringTimeoutSeconds: 20,
    });

    expect(created).toMatchObject({
      label: 'Sales',
      strategy: 'simultaneous',
      memberExtensionIds: [ext1, ext2],
      ringTimeoutSeconds: 20,
      noAnswerDestinationType: null,
      noAnswerDestinationId: null,
    });

    const outboxRows = await h.db.kysely.selectFrom('outbox').selectAll().execute();
    expect(outboxRows.some((row) => row.type === 'pbx.ring_group.created')).toBe(true);
  });

  it('accepts an extension no-answer destination and validates it exists', async () => {
    const tenantId = crypto.randomUUID();
    const ext1 = await createExtension(tenantId, '101');
    const fallback = await createExtension(tenantId, '199');

    const created = await h.ringGroups.create(ctxFor(tenantId), {
      label: 'Support',
      strategy: 'sequential',
      memberExtensionIds: [ext1],
      ringTimeoutSeconds: 15,
      noAnswerDestinationType: 'extension',
      noAnswerDestinationId: fallback,
    });
    expect(created.noAnswerDestinationType).toBe('extension');
    expect(created.noAnswerDestinationId).toBe(fallback);
  });

  it('rejects a no-answer extension destination that does not exist', async () => {
    const tenantId = crypto.randomUUID();
    const ext1 = await createExtension(tenantId, '101');

    await expect(
      h.ringGroups.create(ctxFor(tenantId), {
        label: 'Support',
        strategy: 'sequential',
        memberExtensionIds: [ext1],
        ringTimeoutSeconds: 15,
        noAnswerDestinationType: 'extension',
        noAnswerDestinationId: crypto.randomUUID(),
      }),
    ).rejects.toThrow(RingGroupMemberNotFoundError);
  });

  it('accepts a non-extension no-answer destination type unresolved today (G-25-style honest miss)', async () => {
    const tenantId = crypto.randomUUID();
    const ext1 = await createExtension(tenantId, '101');

    const created = await h.ringGroups.create(ctxFor(tenantId), {
      label: 'Support',
      strategy: 'sequential',
      memberExtensionIds: [ext1],
      ringTimeoutSeconds: 15,
      noAnswerDestinationType: 'voicemail',
      noAnswerDestinationId: crypto.randomUUID(),
    });
    expect(created.noAnswerDestinationType).toBe('voicemail');
  });

  it('rejects a member extension id that does not exist', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.ringGroups.create(ctxFor(tenantId), {
        label: 'Sales',
        strategy: 'simultaneous',
        memberExtensionIds: [crypto.randomUUID()],
        ringTimeoutSeconds: 20,
      }),
    ).rejects.toThrow(RingGroupMemberNotFoundError);
  });

  it('rejects duplicate member extension ids', async () => {
    const tenantId = crypto.randomUUID();
    const ext1 = await createExtension(tenantId, '101');
    await expect(
      h.ringGroups.create(ctxFor(tenantId), {
        label: 'Sales',
        strategy: 'simultaneous',
        memberExtensionIds: [ext1, ext1],
        ringTimeoutSeconds: 20,
      }),
    ).rejects.toThrow(InvalidRingGroupError);
  });

  it('rejects an unknown strategy', async () => {
    const tenantId = crypto.randomUUID();
    const ext1 = await createExtension(tenantId, '101');
    await expect(
      h.ringGroups.create(ctxFor(tenantId), {
        label: 'Sales',
        strategy: 'bogus',
        memberExtensionIds: [ext1],
        ringTimeoutSeconds: 20,
      }),
    ).rejects.toThrow(InvalidRingGroupError);
  });

  it('rejects a ring timeout out of range', async () => {
    const tenantId = crypto.randomUUID();
    const ext1 = await createExtension(tenantId, '101');
    await expect(
      h.ringGroups.create(ctxFor(tenantId), {
        label: 'Sales',
        strategy: 'simultaneous',
        memberExtensionIds: [ext1],
        ringTimeoutSeconds: 1,
      }),
    ).rejects.toThrow(InvalidRingGroupError);
  });

  it('updates strategy and members, bumping version and enqueueing pbx.ring_group.updated', async () => {
    const tenantId = crypto.randomUUID();
    const ext1 = await createExtension(tenantId, '101');
    const ext2 = await createExtension(tenantId, '102');
    const created = await h.ringGroups.create(ctxFor(tenantId), {
      label: 'Sales',
      strategy: 'simultaneous',
      memberExtensionIds: [ext1],
      ringTimeoutSeconds: 20,
    });

    const updated = await h.ringGroups.update(ctxFor(tenantId), created.id, {
      strategy: 'round_robin',
      memberExtensionIds: [ext1, ext2],
    });
    expect(updated.strategy).toBe('round_robin');
    expect(updated.memberExtensionIds).toEqual([ext1, ext2]);

    const outboxRows = await h.db.kysely.selectFrom('outbox').selectAll().execute();
    expect(outboxRows.some((row) => row.type === 'pbx.ring_group.updated')).toBe(true);
  });

  it('throws RingGroupNotFoundError updating a missing ring group', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.ringGroups.update(ctxFor(tenantId), crypto.randomUUID(), { label: 'x' }),
    ).rejects.toThrow(RingGroupNotFoundError);
  });

  it('deletes a ring group and enqueues pbx.ring_group.deleted', async () => {
    const tenantId = crypto.randomUUID();
    const ext1 = await createExtension(tenantId, '101');
    const created = await h.ringGroups.create(ctxFor(tenantId), {
      label: 'Sales',
      strategy: 'simultaneous',
      memberExtensionIds: [ext1],
      ringTimeoutSeconds: 20,
    });

    await h.ringGroups.remove(ctxFor(tenantId), created.id);
    expect(await h.ringGroups.findById(ctxFor(tenantId), created.id)).toBeUndefined();

    const outboxRows = await h.db.kysely.selectFrom('outbox').selectAll().execute();
    expect(outboxRows.some((row) => row.type === 'pbx.ring_group.deleted')).toBe(true);
  });

  it('throws RingGroupNotFoundError deleting a missing ring group', async () => {
    const tenantId = crypto.randomUUID();
    await expect(h.ringGroups.remove(ctxFor(tenantId), crypto.randomUUID())).rejects.toThrow(
      RingGroupNotFoundError,
    );
  });

  crossTenantProbe({
    name: 'ring_groups',
    seed: async (tenantId) => {
      const ext1 = await createExtension(tenantId, '101');
      const created = await h.ringGroups.create(ctxFor(tenantId), {
        label: 'Sales',
        strategy: 'simultaneous',
        memberExtensionIds: [ext1],
        ringTimeoutSeconds: 20,
      });
      return created.id;
    },
    list: (tenantId) => h.ringGroups.list(ctxFor(tenantId)),
    findById: (tenantId, id) => h.ringGroups.findById(ctxFor(tenantId), id),
    remove: (tenantId, id) =>
      h.ringGroups
        .remove(ctxFor(tenantId), id)
        .then(() => 1)
        .catch((error: unknown) => {
          if (error instanceof RingGroupNotFoundError) return 0;
          throw error;
        }),
  });
});
