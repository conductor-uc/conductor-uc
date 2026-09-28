import { randomUUID } from 'node:crypto';

import { silentLogger, startTestRedis, redisOrSkipReason } from '@cuc/testing';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createNodeOwnership, type NodeOwnership } from '../src/node-ownership.js';

const skipReason = await redisOrSkipReason();
const TTL_MS = 300;

describe.skipIf(skipReason !== undefined)('media node ownership across replicas (S4-03)', () => {
  let redis: Redis;
  let keyPrefix: string;
  let replicas: NodeOwnership[] = [];

  beforeAll(async () => {
    redis = new Redis((await startTestRedis()).url, { maxRetriesPerRequest: 2 });
  });

  afterAll(() => {
    redis.disconnect();
  });

  beforeEach(() => {
    keyPrefix = `t${randomUUID().replaceAll('-', '')}:`;
  });

  afterEach(async () => {
    await Promise.all(replicas.map((replica) => replica.stop()));
    replicas = [];
  });

  function replica(
    replicaId: string,
    nodeIds: string[],
    connected: Set<string> = new Set(nodeIds),
  ): { ownership: NodeOwnership; events: string[] } {
    const events: string[] = [];
    const ownership = createNodeOwnership({
      redis,
      keyPrefix,
      replicaId,
      nodeIds,
      isConnected: (nodeId) => connected.has(nodeId),
      onAcquired: (nodeId) => events.push(`+${nodeId}`),
      onLost: (nodeId) => events.push(`-${nodeId}`),
      logger: silentLogger(),
      leaseTtlMs: TTL_MS,
    });
    replicas.push(ownership);
    return { ownership, events };
  }

  it('gives each node exactly one owner, however many replicas look at once', async () => {
    const nodes = ['fs-1', 'fs-2', 'fs-3'];
    const all = ['a', 'b', 'c'].map((id) => replica(id, nodes));
    await Promise.all(all.map(({ ownership }) => ownership.runOnce()));
    for (const node of nodes) {
      expect(all.filter(({ ownership }) => ownership.owns(node))).toHaveLength(1);
    }
    // Renewing keeps them where they are.
    await Promise.all(all.map(({ ownership }) => ownership.runOnce()));
    expect(all.flatMap(({ events }) => events).filter((e) => e.startsWith('-'))).toEqual([]);
  });

  it('another replica takes a node once its owner stops renewing', async () => {
    const a = replica('a', ['fs-1']);
    await a.ownership.runOnce();
    expect(a.ownership.owns('fs-1')).toBe(true);
    const b = replica('b', ['fs-1']);
    await b.ownership.runOnce();
    expect(b.ownership.owns('fs-1')).toBe(false);

    // `a` dies: nothing renews its claim, which lapses.
    await new Promise((resolve) => setTimeout(resolve, TTL_MS + 50));
    await b.ownership.runOnce();
    expect(b.ownership.owns('fs-1')).toBe(true);
    expect(await b.ownership.ownerOf('fs-1')).toBe('b');

    // `a` comes back to life: its renewal fails, and it knows it lost the node.
    await a.ownership.runOnce();
    expect(a.ownership.owns('fs-1')).toBe(false);
    expect(a.events).toEqual(['+fs-1', '-fs-1']);
  });

  it('a replica that loses its socket to a node gives it up at once, to one still connected', async () => {
    const connectedA = new Set(['fs-1']);
    const a = replica('a', ['fs-1'], connectedA);
    const b = replica('b', ['fs-1']);
    await a.ownership.runOnce();
    await b.ownership.runOnce();
    expect(a.ownership.owns('fs-1')).toBe(true);

    connectedA.delete('fs-1');
    await a.ownership.runOnce();
    expect(a.ownership.owns('fs-1')).toBe(false);
    await b.ownership.runOnce();
    expect(b.ownership.owns('fs-1')).toBe(true);
  });

  it('never owns a node it is not connected to', async () => {
    const a = replica('a', ['fs-1'], new Set());
    await a.ownership.runOnce();
    expect(a.ownership.owns('fs-1')).toBe(false);
    expect(await a.ownership.ownerOf('fs-1')).toBeUndefined();
  });

  it('gives its nodes up when it shuts down', async () => {
    const a = replica('a', ['fs-1', 'fs-2']);
    await a.ownership.runOnce();
    await a.ownership.stop();
    expect(await a.ownership.ownerOf('fs-1')).toBeUndefined();
    expect(a.events.sort()).toEqual(['+fs-1', '+fs-2', '-fs-1', '-fs-2'].sort());
    const b = replica('b', ['fs-1', 'fs-2']);
    await b.ownership.runOnce();
    expect(b.ownership.ownedNodeIds().sort()).toEqual(['fs-1', 'fs-2']);
  });
});
