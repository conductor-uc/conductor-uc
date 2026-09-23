import type { Redis } from 'ioredis';

/**
 * Resource affinity leases (04 §3.3, D-010): the kinds of node-pinned
 * resource this platform has. `queue`/`park`/`conf` are `mod_callcenter`/
 * `mod_valet_parking`/`mod_conference` state respectively — each pinned to
 * exactly one FreeSWITCH node at a time because none of those modules'
 * in-memory state is shared across nodes.
 */
export type AffinityKind = 'queue' | 'park' | 'conf';

export interface AffinityLease {
  readonly tenantId: string;
  readonly kind: AffinityKind;
  readonly resourceId: string;
}

/**
 * The lease primitives themselves (S2-12; 04 §3.3's own "Acquisition" and
 * renewal rules) — acquire, renew, and release against `aff:{tenantId}:
 * {kind}:{resourceId}`, one Redis key per resource, holding the owning
 * node's id.
 *
 * This is the abstraction S2-12 scopes to: *which* node should hold a given
 * lease (today: call-control's own "least loaded live node" choice, `04
 * §3.3`) and what a node does with one once it has it (S2-13/14/15's own
 * `mod_callcenter`/`mod_valet_parking`/`mod_conference` wiring) are both
 * built on top of this, not inside it.
 */
export interface AffinityRegistry {
  /**
   * `SET aff:… {node} NX PX ttlMs` (04 §3.3 verbatim) — succeeds only if
   * nothing else currently holds the lease. Returns whether *this* call won
   * it, not whether the lease exists at all (see {@link getOwner} for that).
   */
  acquire(lease: AffinityLease, nodeId: string, ttlMs: number): Promise<boolean>;
  /**
   * Extends the lease's TTL, but only if `nodeId` is still the current
   * holder — a compare-and-set, not a blind `PEXPIRE`, so a node that lost
   * its lease (TTL lapsed and another node already re-acquired it) can never
   * silently renew someone else's ownership out from under them. Returns
   * whether the renewal actually took effect.
   */
  renew(lease: AffinityLease, nodeId: string, ttlMs: number): Promise<boolean>;
  /**
   * Releases the lease, but again only if `nodeId` still holds it — the same
   * compare-and-delete discipline as {@link renew}, for the same reason.
   * Returns whether this call actually released it.
   */
  release(lease: AffinityLease, nodeId: string): Promise<boolean>;
  /** The current holder's node id, or `undefined` if the lease does not exist (idle, released, or never acquired). */
  getOwner(lease: AffinityLease): Promise<string | undefined>;
}

/**
 * Renews only if the key's current value is still `ARGV[1]` — the
 * lease-ownership compare half of `renew`/`release` below. Lua because
 * `GET` then `PEXPIRE`/`DEL` from JS would race against another node's
 * concurrent acquire between the two round-trips; a single `EVAL` is
 * atomic on the Redis server.
 */
const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
else
  return 0
end
`;

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

function leaseKey(keyPrefix: string, lease: AffinityLease): string {
  return `${keyPrefix}aff:${lease.tenantId}:${lease.kind}:${lease.resourceId}`;
}

export function createAffinityRegistry(redis: Redis, keyPrefix: string): AffinityRegistry {
  return {
    async acquire(lease, nodeId, ttlMs) {
      const result = await redis.set(leaseKey(keyPrefix, lease), nodeId, 'PX', ttlMs, 'NX');
      return result === 'OK';
    },

    async renew(lease, nodeId, ttlMs) {
      const result = await redis.eval(RENEW_SCRIPT, 1, leaseKey(keyPrefix, lease), nodeId, ttlMs);
      return result === 1;
    },

    async release(lease, nodeId) {
      const result = await redis.eval(RELEASE_SCRIPT, 1, leaseKey(keyPrefix, lease), nodeId);
      return result === 1;
    },

    async getOwner(lease) {
      const owner = await redis.get(leaseKey(keyPrefix, lease));
      return owner ?? undefined;
    },
  };
}
