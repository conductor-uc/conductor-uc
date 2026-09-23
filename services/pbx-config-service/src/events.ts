import { Type, defineEvents } from '@cuc/api-contracts';

/**
 * This service's event contracts (S1-09; 06's pbx-config-service section:
 * `pbx.{entity}.created|updated|deleted`).
 *
 * `org.domain.added` is registered here too, even though org-service owns
 * it — a consumer needs the contract in its own registry to validate what it
 * receives (`@cuc/events`' `createConsumer`), and services do not import each
 * other's source. This copy must match org-service's `orgEvents` definition;
 * a schemaVersion bump there needs the same bump here, the ordinary
 * dual-publish discipline 05 §5 already asks of every event change.
 */
export const pbxEvents = defineEvents({
  'pbx.extension.created': {
    schemaVersion: 1,
    description: 'An extension was created, with SIP credentials generated for it.',
    data: Type.Object({
      extensionId: Type.String({ minLength: 1 }),
      number: Type.String({ minLength: 1 }),
      displayName: Type.String({ minLength: 1 }),
    }),
  },
  'pbx.extension.updated': {
    schemaVersion: 1,
    description: "An extension's number, display name, caller id, or voicemail setting changed.",
    data: Type.Object({ extensionId: Type.String({ minLength: 1 }) }),
  },
  'pbx.extension.deleted': {
    schemaVersion: 1,
    description: 'An extension (and its SIP credentials) was deleted.',
    data: Type.Object({ extensionId: Type.String({ minLength: 1 }) }),
  },
  'pbx.did.created': {
    schemaVersion: 1,
    description: 'A DID was created and bound to a trunk and a destination.',
    data: Type.Object({
      didId: Type.String({ minLength: 1 }),
      e164: Type.String({ minLength: 1 }),
    }),
  },
  'pbx.did.updated': {
    schemaVersion: 1,
    description: "A DID's trunk binding or destination changed.",
    data: Type.Object({ didId: Type.String({ minLength: 1 }) }),
  },
  'pbx.did.deleted': {
    schemaVersion: 1,
    description: 'A DID was deleted.',
    data: Type.Object({ didId: Type.String({ minLength: 1 }) }),
  },
  /**
   * S2-07: the tenant confirmed their raw upload landed
   * (`media-asset.repo.ts`'s `finalize`) — the transcode worker's own
   * trigger. Thin (06): the worker calls this service's own
   * `GET /internal/v1/tenants/:tenantId/media-assets/:id` for the current
   * `objectKey`/`contentType` rather than trusting anything on the event.
   */
  'pbx.media_asset.finalize_requested': {
    schemaVersion: 1,
    description: "A tenant's uploaded media asset is ready for the transcode worker to pick up.",
    data: Type.Object({ mediaAssetId: Type.String({ minLength: 1 }) }),
  },
  'pbx.ring_group.created': {
    schemaVersion: 1,
    description: 'A ring/hunt group was created.',
    data: Type.Object({ ringGroupId: Type.String({ minLength: 1 }) }),
  },
  'pbx.ring_group.updated': {
    schemaVersion: 1,
    description: "A ring group's strategy, members, timeout, or no-answer destination changed.",
    data: Type.Object({ ringGroupId: Type.String({ minLength: 1 }) }),
  },
  'pbx.ring_group.deleted': {
    schemaVersion: 1,
    description: 'A ring group was deleted.',
    data: Type.Object({ ringGroupId: Type.String({ minLength: 1 }) }),
  },
  'pbx.queue.created': {
    schemaVersion: 1,
    description: 'A call queue was created.',
    data: Type.Object({ queueId: Type.String({ minLength: 1 }) }),
  },
  'pbx.queue.updated': {
    schemaVersion: 1,
    description:
      "A queue's strategy, MOH, wait limits, announcements, or overflow destination changed.",
    data: Type.Object({ queueId: Type.String({ minLength: 1 }) }),
  },
  'pbx.queue.deleted': {
    schemaVersion: 1,
    description: 'A queue was deleted.',
    data: Type.Object({ queueId: Type.String({ minLength: 1 }) }),
  },
  'pbx.agent.created': {
    schemaVersion: 1,
    description: 'An extension was made into an agent.',
    data: Type.Object({ agentId: Type.String({ minLength: 1 }) }),
  },
  'pbx.agent.updated': {
    schemaVersion: 1,
    description: "An agent's max-no-answer, wrap-up, or reject-delay setting changed.",
    data: Type.Object({ agentId: Type.String({ minLength: 1 }) }),
  },
  'pbx.agent.deleted': {
    schemaVersion: 1,
    description: 'An agent was removed (its extension is no longer an agent).',
    data: Type.Object({ agentId: Type.String({ minLength: 1 }) }),
  },
  /**
   * A tier assignment (agent<->queue) changed. Thin like every other event
   * here, but names both ids rather than just a tier row id: the projection
   * needs to know *which queue's* callcenter.conf just went stale, and
   * `queueId` alone (without `agentId`) would still leave it re-fetching
   * every one of that queue's tiers anyway — carrying both costs nothing
   * extra and saves a lookup.
   */
  'pbx.queue_tier.added': {
    schemaVersion: 1,
    description: 'An agent was tiered into a queue.',
    data: Type.Object({
      queueId: Type.String({ minLength: 1 }),
      agentId: Type.String({ minLength: 1 }),
    }),
  },
  'pbx.queue_tier.updated': {
    schemaVersion: 1,
    description: "A tier assignment's level or position changed.",
    data: Type.Object({
      queueId: Type.String({ minLength: 1 }),
      agentId: Type.String({ minLength: 1 }),
    }),
  },
  'pbx.queue_tier.removed': {
    schemaVersion: 1,
    description: 'An agent was removed from a queue.',
    data: Type.Object({
      queueId: Type.String({ minLength: 1 }),
      agentId: Type.String({ minLength: 1 }),
    }),
  },
  'pbx.parking_lot.created': {
    schemaVersion: 1,
    description: 'A parking lot was created.',
    data: Type.Object({ parkingLotId: Type.String({ minLength: 1 }) }),
  },
  'pbx.parking_lot.updated': {
    schemaVersion: 1,
    description: "A parking lot's slot range, timeout, or return destination changed.",
    data: Type.Object({ parkingLotId: Type.String({ minLength: 1 }) }),
  },
  'pbx.parking_lot.deleted': {
    schemaVersion: 1,
    description: 'A parking lot was deleted.',
    data: Type.Object({ parkingLotId: Type.String({ minLength: 1 }) }),
  },
  'org.domain.added': {
    schemaVersion: 1,
    description:
      "Mirrors org-service's contract (05 §5) — consumed here to recompute HA1/HA1B when a " +
      "tenant's primary SIP domain changes (02 §3).",
    data: Type.Object({
      domainId: Type.String({ minLength: 1 }),
      fqdn: Type.String({ minLength: 1 }),
      scope: Type.Union([Type.Literal('tenant'), Type.Literal('reseller_base')]),
      ownerId: Type.String({ minLength: 1 }),
    }),
  },
});
