import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { crossTenantProbe, databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';

import { InvalidAgentError } from '../src/domain/agent.js';
import {
  AgentExtensionNotFoundError,
  AgentNotFoundError,
  ExtensionAlreadyAgentError,
} from '../src/repo/agent.repo.js';
import {
  AgentAlreadyTieredError,
  AgentForTierNotFoundError,
  QueueForTierNotFoundError,
  QueueTierNotFoundError,
} from '../src/repo/queue-tier.repo.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());

describe.skipIf(skipReason !== undefined)('agent repo and queue tiers', () => {
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

  async function createQueue(tenantId: string, label = 'Support'): Promise<string> {
    const queue = await h.queues.create(ctxFor(tenantId), {
      label,
      strategy: 'round-robin',
      maxWaitSeconds: 0,
      announcePosition: false,
    });
    return queue.id;
  }

  it('creates an agent with defaults and enqueues pbx.agent.created', async () => {
    const tenantId = crypto.randomUUID();
    const extensionId = await createExtension(tenantId, '101');

    const created = await h.agents.create(ctxFor(tenantId), { extensionId });

    expect(created).toMatchObject({
      extensionId,
      maxNoAnswer: 3,
      wrapUpSeconds: 0,
      rejectDelaySeconds: 0,
    });

    const outboxRows = await h.db.kysely.selectFrom('outbox').selectAll().execute();
    expect(outboxRows.some((row) => row.type === 'pbx.agent.created')).toBe(true);
  });

  it('rejects an agent for an extension that does not exist', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.agents.create(ctxFor(tenantId), { extensionId: crypto.randomUUID() }),
    ).rejects.toThrow(AgentExtensionNotFoundError);
  });

  it('rejects a second agent for the same extension', async () => {
    const tenantId = crypto.randomUUID();
    const extensionId = await createExtension(tenantId, '101');
    await h.agents.create(ctxFor(tenantId), { extensionId });

    await expect(h.agents.create(ctxFor(tenantId), { extensionId })).rejects.toThrow(
      ExtensionAlreadyAgentError,
    );
  });

  it('rejects an out-of-range maxNoAnswer', async () => {
    const tenantId = crypto.randomUUID();
    const extensionId = await createExtension(tenantId, '101');
    await expect(
      h.agents.create(ctxFor(tenantId), { extensionId, maxNoAnswer: 999 }),
    ).rejects.toThrow(InvalidAgentError);
  });

  it('updates an agent, bumping version and enqueueing pbx.agent.updated', async () => {
    const tenantId = crypto.randomUUID();
    const extensionId = await createExtension(tenantId, '101');
    const created = await h.agents.create(ctxFor(tenantId), { extensionId });

    const updated = await h.agents.update(ctxFor(tenantId), created.id, { wrapUpSeconds: 30 });
    expect(updated.wrapUpSeconds).toBe(30);

    const outboxRows = await h.db.kysely.selectFrom('outbox').selectAll().execute();
    expect(outboxRows.some((row) => row.type === 'pbx.agent.updated')).toBe(true);
  });

  it('throws AgentNotFoundError updating a missing agent', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.agents.update(ctxFor(tenantId), crypto.randomUUID(), { wrapUpSeconds: 1 }),
    ).rejects.toThrow(AgentNotFoundError);
  });

  it('deletes an agent, its tiers, and enqueues pbx.agent.deleted', async () => {
    const tenantId = crypto.randomUUID();
    const extensionId = await createExtension(tenantId, '101');
    const agent = await h.agents.create(ctxFor(tenantId), { extensionId });
    const queueId = await createQueue(tenantId);
    await h.queueTiers.add(ctxFor(tenantId), { queueId, agentId: agent.id });

    await h.agents.remove(ctxFor(tenantId), agent.id);

    expect(await h.agents.findById(ctxFor(tenantId), agent.id)).toBeUndefined();
    expect(await h.queueTiers.listForQueue(ctxFor(tenantId), queueId)).toHaveLength(0);

    const outboxRows = await h.db.kysely.selectFrom('outbox').selectAll().execute();
    expect(outboxRows.some((row) => row.type === 'pbx.agent.deleted')).toBe(true);
  });

  it('throws AgentNotFoundError deleting a missing agent', async () => {
    const tenantId = crypto.randomUUID();
    await expect(h.agents.remove(ctxFor(tenantId), crypto.randomUUID())).rejects.toThrow(
      AgentNotFoundError,
    );
  });

  describe('queue tiers', () => {
    it('adds a tier with defaults and enqueues pbx.queue_tier.added', async () => {
      const tenantId = crypto.randomUUID();
      const extensionId = await createExtension(tenantId, '101');
      const agent = await h.agents.create(ctxFor(tenantId), { extensionId });
      const queueId = await createQueue(tenantId);

      const tier = await h.queueTiers.add(ctxFor(tenantId), {
        queueId,
        agentId: agent.id,
      });

      expect(tier).toMatchObject({ queueId, agentId: agent.id, level: 1, position: 1 });

      const outboxRows = await h.db.kysely.selectFrom('outbox').selectAll().execute();
      expect(outboxRows.some((row) => row.type === 'pbx.queue_tier.added')).toBe(true);
    });

    it('rejects a tier for a queue that does not exist', async () => {
      const tenantId = crypto.randomUUID();
      const extensionId = await createExtension(tenantId, '101');
      const agent = await h.agents.create(ctxFor(tenantId), { extensionId });

      await expect(
        h.queueTiers.add(ctxFor(tenantId), { queueId: crypto.randomUUID(), agentId: agent.id }),
      ).rejects.toThrow(QueueForTierNotFoundError);
    });

    it('rejects a tier for an agent that does not exist', async () => {
      const tenantId = crypto.randomUUID();
      const queueId = await createQueue(tenantId);

      await expect(
        h.queueTiers.add(ctxFor(tenantId), { queueId, agentId: crypto.randomUUID() }),
      ).rejects.toThrow(AgentForTierNotFoundError);
    });

    it('rejects tiering the same agent into the same queue twice', async () => {
      const tenantId = crypto.randomUUID();
      const extensionId = await createExtension(tenantId, '101');
      const agent = await h.agents.create(ctxFor(tenantId), { extensionId });
      const queueId = await createQueue(tenantId);
      await h.queueTiers.add(ctxFor(tenantId), { queueId, agentId: agent.id });

      await expect(
        h.queueTiers.add(ctxFor(tenantId), { queueId, agentId: agent.id }),
      ).rejects.toThrow(AgentAlreadyTieredError);
    });

    it('lets one agent tier into several queues', async () => {
      const tenantId = crypto.randomUUID();
      const extensionId = await createExtension(tenantId, '101');
      const agent = await h.agents.create(ctxFor(tenantId), { extensionId });
      const queueA = await createQueue(tenantId, 'Support');
      const queueB = await createQueue(tenantId, 'Sales');

      await h.queueTiers.add(ctxFor(tenantId), { queueId: queueA, agentId: agent.id });
      await h.queueTiers.add(ctxFor(tenantId), { queueId: queueB, agentId: agent.id });

      expect(await h.queueTiers.listForAgent(ctxFor(tenantId), agent.id)).toHaveLength(2);
    });

    it('updates a tier level/position and enqueues pbx.queue_tier.updated', async () => {
      const tenantId = crypto.randomUUID();
      const extensionId = await createExtension(tenantId, '101');
      const agent = await h.agents.create(ctxFor(tenantId), { extensionId });
      const queueId = await createQueue(tenantId);
      const tier = await h.queueTiers.add(ctxFor(tenantId), { queueId, agentId: agent.id });

      const updated = await h.queueTiers.update(ctxFor(tenantId), tier.id, { level: 2 });
      expect(updated.level).toBe(2);

      const outboxRows = await h.db.kysely.selectFrom('outbox').selectAll().execute();
      expect(outboxRows.some((row) => row.type === 'pbx.queue_tier.updated')).toBe(true);
    });

    it('throws QueueTierNotFoundError updating a missing tier', async () => {
      const tenantId = crypto.randomUUID();
      await expect(
        h.queueTiers.update(ctxFor(tenantId), crypto.randomUUID(), { level: 2 }),
      ).rejects.toThrow(QueueTierNotFoundError);
    });

    it('removes a tier and enqueues pbx.queue_tier.removed', async () => {
      const tenantId = crypto.randomUUID();
      const extensionId = await createExtension(tenantId, '101');
      const agent = await h.agents.create(ctxFor(tenantId), { extensionId });
      const queueId = await createQueue(tenantId);
      const tier = await h.queueTiers.add(ctxFor(tenantId), { queueId, agentId: agent.id });

      await h.queueTiers.remove(ctxFor(tenantId), tier.id);
      expect(await h.queueTiers.listForQueue(ctxFor(tenantId), queueId)).toHaveLength(0);

      const outboxRows = await h.db.kysely.selectFrom('outbox').selectAll().execute();
      expect(outboxRows.some((row) => row.type === 'pbx.queue_tier.removed')).toBe(true);
    });

    it('orders tiers by level then position', async () => {
      const tenantId = crypto.randomUUID();
      const ext1 = await createExtension(tenantId, '101');
      const ext2 = await createExtension(tenantId, '102');
      const agent1 = await h.agents.create(ctxFor(tenantId), { extensionId: ext1 });
      const agent2 = await h.agents.create(ctxFor(tenantId), { extensionId: ext2 });
      const queueId = await createQueue(tenantId);

      await h.queueTiers.add(ctxFor(tenantId), {
        queueId,
        agentId: agent2.id,
        level: 1,
        position: 2,
      });
      await h.queueTiers.add(ctxFor(tenantId), {
        queueId,
        agentId: agent1.id,
        level: 1,
        position: 1,
      });

      const tiers = await h.queueTiers.listForQueue(ctxFor(tenantId), queueId);
      expect(tiers.map((t) => t.agentId)).toEqual([agent1.id, agent2.id]);
    });
  });

  crossTenantProbe({
    name: 'agents',
    seed: async (tenantId) => {
      const extensionId = await createExtension(tenantId, '101');
      const created = await h.agents.create(ctxFor(tenantId), { extensionId });
      return created.id;
    },
    list: (tenantId) => h.agents.list(ctxFor(tenantId)),
    findById: (tenantId, id) => h.agents.findById(ctxFor(tenantId), id),
    remove: (tenantId, id) =>
      h.agents
        .remove(ctxFor(tenantId), id)
        .then(() => 1)
        .catch((error: unknown) => {
          if (error instanceof AgentNotFoundError) return 0;
          throw error;
        }),
  });
});
