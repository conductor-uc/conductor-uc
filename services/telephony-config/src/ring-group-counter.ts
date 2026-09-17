import type { Redis } from 'ioredis';

/**
 * S2-08's own round-robin counter: "the counter lives in Redis, not on the
 * node" (the plan's own words) — each inbound call to a `round_robin` ring
 * group increments a per-(tenant, ring group) counter and starts hunting
 * from `counter % memberCount`, so the *next* call picks up where the last
 * one left off, even across FS nodes (S2-19) or a node restart.
 *
 * `INCR` is atomic in Redis, so concurrent calls to the same ring group never
 * pick the same starting member — no read-modify-write race the way a plain
 * `GET` then `SET` would have.
 */
export async function nextRoundRobinStart(
  redis: Redis,
  tenantId: string,
  ringGroupId: string,
  memberCount: number,
): Promise<number> {
  if (memberCount <= 0) return 0;
  const key = `ring-group:${tenantId}:${ringGroupId}:round-robin`;
  const counter = await redis.incr(key);
  return (counter - 1) % memberCount;
}
