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
