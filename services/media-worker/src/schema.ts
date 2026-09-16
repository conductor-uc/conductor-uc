import type { EventTables } from '@cuc/events';

/**
 * This service's own schema — `EventTables` alone (`outbox` + `consumed_events`),
 * nothing else (05 §1.1: each service owns its own schema). Genuinely no
 * business data of its own: it never persists a tenant's raw upload or the
 * transcoded output beyond the lifetime of one job (S2-07's own isolation
 * scope — nothing here should outlive a restart, the same
 * "FreeSWITCH nodes stay stateless" spirit CLAUDE.md rule 5 states for a
 * different kind of node). `consumed_events` is what actually needs a real
 * database at all (`@cuc/events`' `createConsumer`: dedupe must survive a
 * restart, so it lives in SQL, not memory) — `outbox` stays permanently
 * unwritten here (this service never publishes its own event; its
 * `pbx.media_asset.finalize_requested` handler reports back to
 * pbx-config-service over a direct internal HTTP call instead, `main.ts`'s
 * own doc comment on why), but is declared anyway so this interface
 * satisfies `@cuc/events`' `EventTables` constraint without a type that
 * lies about what physically exists — `EventTables`' own `createEventTables`
 * still creates both tables in the migration, the same as every other
 * service, rather than this being a special case to remember.
 */
export type MediaWorkerDb = EventTables;
