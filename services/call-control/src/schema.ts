import type { EventTables } from '@cuc/events';

/**
 * This service's own schema — `EventTables` alone (`outbox` + `consumed_events`),
 * nothing else (05 §1.1: each service owns its own schema). Call ownership
 * itself lives in Redis (04 §3), not here — MariaDB only exists so
 * `consumed_events` dedupe (this service consumes nothing yet, but the
 * migration is uniform across every service per S2-07's own precedent) and
 * the `outbox` relay have somewhere durable to write.
 *
 * `outbox` is genuinely used here (unlike media-worker): every ESL channel
 * event this service normalizes is enqueued as a `call.channel.*` event
 * (`channel-handler.ts`) for cdr-service and future queue/park/conference
 * consumers to build on. There is deliberately no single SQL transaction
 * wrapping an outbox insert together with a "business row" the way
 * `media-asset.repo.ts`'s `finalize()` does — there is no business row: the
 * Redis registry update in `redis/registry.ts` happens as a second,
 * non-atomic step right after the outbox insert, not inside the same
 * transaction. That is intentional, not an oversight: 04 §1 states Redis
 * "holds ownership records with a TTL and heartbeat, not call-state
 * snapshots" and is explicitly not the system of record (04 §5 documents a
 * full rebuild-from-FS procedure for exactly this reason) — the outbox row
 * is the durable trail; a crash between the two steps leaves Redis one event
 * stale until the next event for that call arrives or a restart resyncs it,
 * which is the "no mid-call state replication" tradeoff 04 §1 already
 * accepts, not a new one this service introduces.
 */
export type CallControlDb = EventTables;
