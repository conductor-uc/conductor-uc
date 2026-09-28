import { randomUUID } from 'node:crypto';
import { connect as netConnect } from 'node:net';

import { createAffinityRegistry } from '@cuc/affinity';
import {
  silentLogger,
  startTestRedis,
  redisOrSkipReason,
  type TestRedisHandle,
} from '@cuc/testing';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAffinityManager, type AffinityManager } from '../src/affinity/manager.js';
import { createEslClient, type EslClient } from '../src/esl/client.js';
import { createCallRegistry, type CallRegistry } from '../src/redis/registry.js';
import { startFakeEslServer, type FakeEslServer } from './fake-esl-server.js';

const skipReason = await redisOrSkipReason();
const PASSWORD = 'test-esl-password';
const LEASE_TTL_MS = 500;
const RENEW_INTERVAL_MS = 100;

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe.skipIf(skipReason !== undefined)('affinity manager (S2-12; 04 §3.3)', () => {
  let redis: Redis;
  // A fresh key prefix per test (not just per suite, unlike most other
  // harnesses here): `liveNodeIds()`/"least loaded" selection reasons about
  // *every* node visible under a prefix, so leftover heartbeats or call
  // counts from an earlier test in the same keyspace would silently change
  // which node a later test's acquire picks.
  let keyPrefix: string;
  let callRegistry: CallRegistry;
  let fakeServers: FakeEslServer[] = [];
  let eslClients: EslClient[] = [];
  let managers: AffinityManager[] = [];

  beforeAll(async () => {
    const redisHandle: TestRedisHandle = await startTestRedis();
    redis = new Redis(redisHandle.url, { lazyConnect: false, maxRetriesPerRequest: 2 });
  });

  afterAll(() => {
    redis.disconnect();
  });

  beforeEach(() => {
    keyPrefix = `t${randomUUID().replaceAll('-', '')}:`;
    callRegistry = createCallRegistry(redis, keyPrefix);
  });

  afterEach(async () => {
    for (const manager of managers) manager.stop();
    managers = [];
    await Promise.all(eslClients.map((client) => client.stop()));
    await Promise.all(fakeServers.map((server) => server.close()));
    eslClients = [];
    fakeServers = [];
  });

  /** Spins up a fake FS node with a real, connected ESL client, and registers it live (heartbeat) in the call registry. */
  async function addLiveNode(nodeId: string, callCount: number): Promise<FakeEslServer> {
    const server = await startFakeEslServer(PASSWORD);
    fakeServers.push(server);

    const connected: string[] = [];
    const client = createEslClient({
      node: { id: nodeId, host: '127.0.0.1', port: server.port },
      password: PASSWORD,
      logger: silentLogger(),
      reconnectMinDelayMs: 50,
      reconnectMaxDelayMs: 200,
      onEvent: () => {},
      onConnect: (id) => connected.push(id),
      connect: (port, host) => netConnect(port, host),
    });
    eslClients.push(client);
    client.start();
    await waitFor(() => connected.includes(nodeId));

    await callRegistry.heartbeat(nodeId, 10_000);
    for (let i = 0; i < callCount; i++) {
      await callRegistry.createCall(
        {
          callUuid: randomUUID(),
          nodeId,
          tenantId: null,
          direction: 'inbound',
          state: 'ringing',
          startedAt: String(Date.now()),
          from: '1000',
          to: '2000',
          extension: null,
          controls: 'none',
        },
        6 * 60 * 60 * 1000,
      );
    }

    return server;
  }

  /** Builds a manager wired to every ESL client started so far via `addLiveNode`, keyed by the same node ids. */
  function newManager(): AffinityManager {
    const manager = createAffinityManager({
      redis,
      keyPrefix,
      callRegistry,
      eslClients: new Map(eslClients.map((client, i) => [`fs-${String(i)}`, client])),
      logger: silentLogger(),
      leaseTtlMs: LEASE_TTL_MS,
      renewIntervalMs: RENEW_INTERVAL_MS,
    });
    managers.push(manager);
    return manager;
  }

  it('acquires on the least-loaded live node and sends xml_flush_cache plus any reload commands', async () => {
    await addLiveNode('fs-0', 3);
    await addLiveNode('fs-1', 0);

    const manager = newManager();
    const tenantId = randomUUID();
    const resourceId = randomUUID();

    const result = await manager.acquire(tenantId, 'queue', resourceId, {
      reloadCommands: ['callcenter_config reload'],
    });

    expect(result).toEqual({ nodeId: 'fs-1', acquired: true });
    await waitFor(() => (fakeServers[1]?.receivedApiCommands.length ?? 0) >= 2);
    expect(fakeServers[1]?.receivedApiCommands).toEqual([
      'xml_flush_cache',
      'callcenter_config reload',
    ]);
    expect(fakeServers[0]?.receivedApiCommands).toEqual([]);
  });

  it('is idempotent: acquiring an already-held lease again returns the same node without re-acquiring', async () => {
    await addLiveNode('fs-0', 0);

    const manager = newManager();
    const tenantId = randomUUID();
    const resourceId = randomUUID();

    const first = await manager.acquire(tenantId, 'park', resourceId);
    const second = await manager.acquire(tenantId, 'park', resourceId);

    expect(first).toEqual({ nodeId: 'fs-0', acquired: true });
    expect(second).toEqual({ nodeId: 'fs-0', acquired: false });
    await waitFor(() => (fakeServers[0]?.receivedApiCommands.length ?? 0) >= 1);
    expect(fakeServers[0]?.receivedApiCommands).toEqual(['xml_flush_cache']);
  });

  it('renews the lease on an interval while held, keeping the TTL alive past the original window', async () => {
    await addLiveNode('fs-0', 0);

    const manager = newManager();
    const tenantId = randomUUID();
    const resourceId = randomUUID();

    await manager.acquire(tenantId, 'conf', resourceId);

    await new Promise((resolve) => setTimeout(resolve, LEASE_TTL_MS + RENEW_INTERVAL_MS * 2));

    const registry = createAffinityRegistry(redis, keyPrefix);
    expect(await registry.getOwner({ tenantId, kind: 'conf', resourceId })).toBe('fs-0');
  });

  it("S4-03: the node's owner keeps a lease alive after the replica that acquired it is gone", async () => {
    await addLiveNode('fs-0', 0);
    const tenantId = randomUUID();
    const resourceId = randomUUID();
    const acquirer = newManager();
    await acquirer.acquire(tenantId, 'queue', resourceId);
    acquirer.stop(); // Its replica dies: nothing it started renews the lease any more.

    const owner = newManager();
    const deadline = Date.now() + LEASE_TTL_MS * 3;
    while (Date.now() < deadline) {
      expect(await owner.renewHeldBy('fs-0')).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, RENEW_INTERVAL_MS));
    }
    const registry = createAffinityRegistry(redis, keyPrefix);
    expect(await registry.getOwner({ tenantId, kind: 'queue', resourceId })).toBe('fs-0');
    expect(await owner.renewHeldBy('fs-1')).toBe(0);
  });

  it('S4-03: answers from Redis, not its memory, once another replica has released the lease', async () => {
    await addLiveNode('fs-0', 0);
    await addLiveNode('fs-1', 0);
    const tenantId = randomUUID();
    const resourceId = randomUUID();
    const acquirer = newManager();
    expect(
      await acquirer.acquire(tenantId, 'conf', resourceId, { preferredNodeId: 'fs-0' }),
    ).toEqual({ nodeId: 'fs-0', acquired: true });

    // Another replica handles fs-0's death and releases its leases.
    await newManager().handOver('fs-0');

    expect(
      await acquirer.acquire(tenantId, 'conf', resourceId, { preferredNodeId: 'fs-1' }),
    ).toEqual({ nodeId: 'fs-1', acquired: true });
  });

  it("S4-02: hands a drained node's leases over, so the next acquire lands on a live node", async () => {
    await addLiveNode('fs-0', 0);
    await addLiveNode('fs-1', 5);

    const manager = newManager();
    const tenantId = randomUUID();
    const queueId = randomUUID();
    const confId = randomUUID();
    expect((await manager.acquire(tenantId, 'queue', queueId)).nodeId).toBe('fs-0');
    expect((await manager.acquire(tenantId, 'conf', confId)).nodeId).toBe('fs-0');
    const other = await newManager().acquire(tenantId, 'park', 'lot', { preferredNodeId: 'fs-1' });
    expect(other.nodeId).toBe('fs-1');

    await callRegistry.setDraining('fs-0', true);
    expect(await manager.handOver('fs-0')).toBe(2);

    // Nothing renews them back.
    await new Promise((resolve) => setTimeout(resolve, RENEW_INTERVAL_MS * 3));
    expect(await manager.getOwner(tenantId, 'queue', queueId)).toBeUndefined();
    expect(await manager.getOwner(tenantId, 'park', 'lot')).toBe('fs-1');

    // fs-1 is busier, but fs-0 is draining.
    expect(await manager.acquire(tenantId, 'queue', queueId)).toEqual({
      nodeId: 'fs-1',
      acquired: true,
    });
  });

  it('S4-04: sets its leases again after Redis lost them, and gives up one taken meanwhile', async () => {
    await addLiveNode('fs-0', 0);
    const manager = newManager();
    const tenantId = randomUUID();
    const queueId = randomUUID();
    const confId = randomUUID();
    await manager.acquire(tenantId, 'queue', queueId);
    await manager.acquire(tenantId, 'conf', confId);
    const registry = createAffinityRegistry(redis, keyPrefix);

    // Redis loses both; another replica takes the conference meanwhile.
    await registry.release({ tenantId, kind: 'queue', resourceId: queueId }, 'fs-0');
    await registry.release({ tenantId, kind: 'conf', resourceId: confId }, 'fs-0');
    await registry.acquire({ tenantId, kind: 'conf', resourceId: confId }, 'fs-9', 60_000);

    expect(await manager.restore()).toBe(1);
    expect(await manager.getOwner(tenantId, 'queue', queueId)).toBe('fs-0');
    expect(await manager.getOwner(tenantId, 'conf', confId)).toBe('fs-9');
    // No longer this replica's: a later acquire asks Redis, not its own memory.
    expect((await manager.acquire(tenantId, 'conf', confId)).nodeId).toBe('fs-9');
    manager.stop();
  });

  it('releases the lease and stops renewing it', async () => {
    await addLiveNode('fs-0', 0);

    const manager = newManager();
    const tenantId = randomUUID();
    const resourceId = randomUUID();

    await manager.acquire(tenantId, 'queue', resourceId);
    expect(await manager.getOwner(tenantId, 'queue', resourceId)).toBe('fs-0');

    await manager.release(tenantId, 'queue', resourceId);
    expect(await manager.getOwner(tenantId, 'queue', resourceId)).toBeUndefined();

    // Stays released: nothing is renewing it anymore.
    await new Promise((resolve) => setTimeout(resolve, RENEW_INTERVAL_MS * 2));
    expect(await manager.getOwner(tenantId, 'queue', resourceId)).toBeUndefined();
  });

  it('reports the existing holder without re-sending reload commands when leased elsewhere', async () => {
    await addLiveNode('fs-0', 0);
    await addLiveNode('fs-1', 0);

    const managerA = newManager();
    const tenantId = randomUUID();
    const resourceId = randomUUID();

    const first = await managerA.acquire(tenantId, 'queue', resourceId);
    const firstServerIndex = first.nodeId === 'fs-0' ? 0 : 1;
    await waitFor(() => (fakeServers[firstServerIndex]?.receivedApiCommands.length ?? 0) >= 1);

    // A second manager instance (stand-in for another call-control replica,
    // or the same one after a restart with no in-memory tracking) must see
    // the same holder rather than trying to steal or re-acquire it.
    const managerB = newManager();
    const second = await managerB.acquire(tenantId, 'queue', resourceId);

    expect(second).toEqual({ nodeId: first.nodeId, acquired: false });
    const totalReloadCommands =
      (fakeServers[0]?.receivedApiCommands.length ?? 0) +
      (fakeServers[1]?.receivedApiCommands.length ?? 0);
    expect(totalReloadCommands).toBe(1);
  });

  it('throws when no live FreeSWITCH nodes are available', async () => {
    const manager = newManager();
    await expect(manager.acquire(randomUUID(), 'queue', randomUUID())).rejects.toThrow(
      'no live FreeSWITCH nodes',
    );
  });

  it('acquires on preferredNodeId rather than the least-loaded node, when it is live (S2-13)', async () => {
    await addLiveNode('fs-0', 0);
    await addLiveNode('fs-1', 5); // more loaded, but explicitly preferred below

    const manager = newManager();
    const tenantId = randomUUID();
    const resourceId = randomUUID();

    const result = await manager.acquire(tenantId, 'queue', resourceId, {
      preferredNodeId: 'fs-1',
    });

    expect(result).toEqual({ nodeId: 'fs-1', acquired: true });
  });

  it('falls back to the least-loaded live node when preferredNodeId is not live', async () => {
    await addLiveNode('fs-0', 0);

    const manager = newManager();
    const tenantId = randomUUID();
    const resourceId = randomUUID();

    const result = await manager.acquire(tenantId, 'queue', resourceId, {
      preferredNodeId: 'fs-dead',
    });

    expect(result).toEqual({ nodeId: 'fs-0', acquired: true });
  });
});
