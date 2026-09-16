import { Type, defineEvents } from '@cuc/api-contracts';

/**
 * This service's event contracts.
 *
 * Subjects are validated at registration, so a typo fails at startup rather
 * than at first publish. A breaking change to `data` needs a new
 * `schemaVersion` and a dual-publish period (05 §5).
 *
 * `callflow` is its own event domain (`@cuc/api-contracts`'s
 * `EVENT_DOMAINS`) — flows are this service's own resource, the same
 * ownership reasoning as S2-07's `pbx.media_asset.finalize_requested`
 * (contrast S2-06's `call.emergency.initiated`, a genuinely cross-cutting
 * event with no single owning table).
 */
export const flowEvents = defineEvents({
  /**
   * Fired whenever the *active* published version of a flow changes — both
   * `:publish` (a new version becomes active) and `:rollback` (an older
   * version becomes active again). A consumer (S2-10's flow_runner cache,
   * eventually telephony-config) only cares which version is current now,
   * not which action got it there, so both paths emit the same type rather
   * than a separate `callflow.flow.rolled_back`.
   */
  'callflow.flow.published': {
    schemaVersion: 1,
    description: 'A flow’s current published version changed.',
    data: Type.Object({
      flowId: Type.String({ minLength: 1 }),
      versionId: Type.String({ minLength: 1 }),
      versionNumber: Type.Number({ minimum: 1 }),
    }),
  },
});
