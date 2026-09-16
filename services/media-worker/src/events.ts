import { Type, defineEvents } from '@cuc/api-contracts';

/**
 * This service's own event registry (S2-07). `pbx.media_asset.finalize_requested`
 * is registered here too, even though pbx-config-service owns it — a
 * consumer needs the contract in its own registry to validate what it
 * receives (`@cuc/events`' `createConsumer`), and services do not import
 * each other's source. This copy must match pbx-config-service's own
 * `pbxEvents` definition; a schemaVersion bump there needs the same bump
 * here, the ordinary dual-publish discipline 05 §5 already asks of every
 * event change.
 *
 * This service never publishes its own event (`schema.ts`'s own doc comment
 * on why) — this registry exists purely to validate what it consumes.
 */
export const mediaWorkerEvents = defineEvents({
  'pbx.media_asset.finalize_requested': {
    schemaVersion: 1,
    description: "A tenant's uploaded media asset is ready for the transcode worker to pick up.",
    data: Type.Object({ mediaAssetId: Type.String({ minLength: 1 }) }),
  },
});
