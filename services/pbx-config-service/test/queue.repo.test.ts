import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { crossTenantProbe, databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';

import { InvalidQueueError } from '../src/domain/queue.js';
import { QueueNotFoundError } from '../src/repo/queue.repo.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());

describe.skipIf(skipReason !== undefined)('queue repo', () => {
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

  it('creates a queue with defaults and enqueues pbx.queue.created', async () => {
    const tenantId = crypto.randomUUID();

    const created = await h.queues.create(ctxFor(tenantId), {
      label: 'Support',
      strategy: 'longest-idle-agent',
      maxWaitSeconds: 0,
      announcePosition: false,
    });

    expect(created).toMatchObject({
      label: 'Support',
      strategy: 'longest-idle-agent',
      mohMediaAssetId: null,
      maxWaitSeconds: 0,
      announcePosition: false,
      announceFrequencySeconds: null,
      noAgentDestinationType: null,
      noAgentDestinationId: null,
    });

    const outboxRows = await h.db.kysely.selectFrom('outbox').selectAll().execute();
    expect(outboxRows.some((row) => row.type === 'pbx.queue.created')).toBe(true);
  });

  it('accepts announcePosition with a frequency', async () => {
    const tenantId = crypto.randomUUID();
    const created = await h.queues.create(ctxFor(tenantId), {
      label: 'Support',
      strategy: 'round-robin',
      maxWaitSeconds: 300,
      announcePosition: true,
      announceFrequencySeconds: 30,
    });
    expect(created.announcePosition).toBe(true);
    expect(created.announceFrequencySeconds).toBe(30);
  });

  it('rejects announceFrequencySeconds without announcePosition', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.queues.create(ctxFor(tenantId), {
        label: 'Support',
        strategy: 'round-robin',
        maxWaitSeconds: 300,
        announcePosition: false,
        announceFrequencySeconds: 30,
      }),
    ).rejects.toThrow(InvalidQueueError);
  });

  it('rejects announcePosition true with no frequency', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.queues.create(ctxFor(tenantId), {
        label: 'Support',
        strategy: 'round-robin',
        maxWaitSeconds: 300,
        announcePosition: true,
      }),
    ).rejects.toThrow(InvalidQueueError);
  });

  it('rejects an unknown strategy', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.queues.create(ctxFor(tenantId), {
        label: 'Support',
        strategy: 'bogus',
        maxWaitSeconds: 0,
        announcePosition: false,
      }),
    ).rejects.toThrow(InvalidQueueError);
  });

  it('accepts a no-agent overflow destination', async () => {
    const tenantId = crypto.randomUUID();
    const created = await h.queues.create(ctxFor(tenantId), {
      label: 'Support',
      strategy: 'round-robin',
      maxWaitSeconds: 0,
      announcePosition: false,
      noAgentDestinationType: 'voicemail',
      noAgentDestinationId: crypto.randomUUID(),
    });
    expect(created.noAgentDestinationType).toBe('voicemail');
  });

  it('updates a queue, bumping version and enqueueing pbx.queue.updated', async () => {
    const tenantId = crypto.randomUUID();
    const created = await h.queues.create(ctxFor(tenantId), {
      label: 'Support',
      strategy: 'round-robin',
      maxWaitSeconds: 0,
      announcePosition: false,
    });

    const updated = await h.queues.update(ctxFor(tenantId), created.id, {
      strategy: 'ring-all',
      maxWaitSeconds: 120,
    });
    expect(updated.strategy).toBe('ring-all');
    expect(updated.maxWaitSeconds).toBe(120);

    const outboxRows = await h.db.kysely.selectFrom('outbox').selectAll().execute();
    expect(outboxRows.some((row) => row.type === 'pbx.queue.updated')).toBe(true);
  });

  it('throws QueueNotFoundError updating a missing queue', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.queues.update(ctxFor(tenantId), crypto.randomUUID(), { label: 'x' }),
    ).rejects.toThrow(QueueNotFoundError);
  });

  it('deletes a queue and enqueues pbx.queue.deleted', async () => {
    const tenantId = crypto.randomUUID();
    const created = await h.queues.create(ctxFor(tenantId), {
      label: 'Support',
      strategy: 'round-robin',
      maxWaitSeconds: 0,
      announcePosition: false,
    });

    await h.queues.remove(ctxFor(tenantId), created.id);
    expect(await h.queues.findById(ctxFor(tenantId), created.id)).toBeUndefined();

    const outboxRows = await h.db.kysely.selectFrom('outbox').selectAll().execute();
    expect(outboxRows.some((row) => row.type === 'pbx.queue.deleted')).toBe(true);
  });

  it('deleting a queue also removes its tiers', async () => {
    const tenantId = crypto.randomUUID();
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
      number: '101',
      displayName: 'Extension 101',
      emergencyLocationId: location.id,
    });
    const agent = await h.agents.create(ctxFor(tenantId), { extensionId: extension.id });
    const queue = await h.queues.create(ctxFor(tenantId), {
      label: 'Support',
      strategy: 'round-robin',
      maxWaitSeconds: 0,
      announcePosition: false,
    });
    await h.queueTiers.add(ctxFor(tenantId), { queueId: queue.id, agentId: agent.id });

    await h.queues.remove(ctxFor(tenantId), queue.id);

    expect(await h.queueTiers.listForQueue(ctxFor(tenantId), queue.id)).toHaveLength(0);
  });

  it('throws QueueNotFoundError deleting a missing queue', async () => {
    const tenantId = crypto.randomUUID();
    await expect(h.queues.remove(ctxFor(tenantId), crypto.randomUUID())).rejects.toThrow(
      QueueNotFoundError,
    );
  });

  crossTenantProbe({
    name: 'queues',
    seed: async (tenantId) => {
      const created = await h.queues.create(ctxFor(tenantId), {
        label: 'Support',
        strategy: 'round-robin',
        maxWaitSeconds: 0,
        announcePosition: false,
      });
      return created.id;
    },
    list: (tenantId) => h.queues.list(ctxFor(tenantId)),
    findById: (tenantId, id) => h.queues.findById(ctxFor(tenantId), id),
    remove: (tenantId, id) =>
      h.queues
        .remove(ctxFor(tenantId), id)
        .then(() => 1)
        .catch((error: unknown) => {
          if (error instanceof QueueNotFoundError) return 0;
          throw error;
        }),
  });
});
