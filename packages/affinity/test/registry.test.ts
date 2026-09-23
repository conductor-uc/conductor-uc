import { randomUUID } from 'node:crypto';

import { redisOrSkipReason, startTestRedis, type TestRedisHandle } from '@cuc/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAffinityRegistry, type AffinityLease, type AffinityRegistry } from '../src/index.js';

const skipReason = await redisOrSkipReason();

describe.skipIf(skipReason !== undefined)('affinity lease registry (04 §3.3)', () => {
  let redisHandle: TestRedisHandle;
  let redis: Redis;
  let registry: AffinityRegistry;

  beforeAll(async () => {
    redisHandle = await startTestRedis();
    redis = new Redis(redisHandle.url, { lazyConnect: false, maxRetriesPerRequest: 2 });
    registry = createAffinityRegistry(redis, redisHandle.keyPrefix);
  });

  afterAll(async () => {
    redis.disconnect();
    await redisHandle.stop();
  });

  function newLease(): AffinityLease {
    return { tenantId: randomUUID(), kind: 'queue', resourceId: randomUUID() };
  }

  it('acquires an unheld lease and reports the holder', async () => {
    const lease = newLease();

    expect(await registry.getOwner(lease)).toBeUndefined();
    expect(await registry.acquire(lease, 'fs-1', 30_000)).toBe(true);
    expect(await registry.getOwner(lease)).toBe('fs-1');

    const ttl = await redis.pttl(
      `${redisHandle.keyPrefix}aff:${lease.tenantId}:queue:${lease.resourceId}`,
    );
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30_000);
  });

  it('refuses to acquire a lease another node already holds', async () => {
    const lease = newLease();

    expect(await registry.acquire(lease, 'fs-1', 30_000)).toBe(true);
    expect(await registry.acquire(lease, 'fs-2', 30_000)).toBe(false);
    expect(await registry.getOwner(lease)).toBe('fs-1');
  });

  it('renews only for the current holder, extending the TTL', async () => {
    const lease = newLease();
    const key = `${redisHandle.keyPrefix}aff:${lease.tenantId}:queue:${lease.resourceId}`;

    await registry.acquire(lease, 'fs-1', 1_000);
    expect(await registry.renew(lease, 'fs-2', 30_000)).toBe(false);

    expect(await registry.renew(lease, 'fs-1', 30_000)).toBe(true);
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(1_000);
  });

  it('releases only for the current holder', async () => {
    const lease = newLease();

    await registry.acquire(lease, 'fs-1', 30_000);
    expect(await registry.release(lease, 'fs-2')).toBe(false);
    expect(await registry.getOwner(lease)).toBe('fs-1');

    expect(await registry.release(lease, 'fs-1')).toBe(true);
    expect(await registry.getOwner(lease)).toBeUndefined();
  });

  it('lets another node acquire once the lease lapses or is released', async () => {
    const lease = newLease();

    await registry.acquire(lease, 'fs-1', 30_000);
    await registry.release(lease, 'fs-1');

    expect(await registry.acquire(lease, 'fs-2', 30_000)).toBe(true);
    expect(await registry.getOwner(lease)).toBe('fs-2');
  });

  it('keeps queue/park/conf leases on the same resourceId independent', async () => {
    const tenantId = randomUUID();
    const resourceId = randomUUID();
    const queueLease: AffinityLease = { tenantId, kind: 'queue', resourceId };
    const confLease: AffinityLease = { tenantId, kind: 'conf', resourceId };

    await registry.acquire(queueLease, 'fs-1', 30_000);
    expect(await registry.acquire(confLease, 'fs-2', 30_000)).toBe(true);

    expect(await registry.getOwner(queueLease)).toBe('fs-1');
    expect(await registry.getOwner(confLease)).toBe('fs-2');
  });
});
