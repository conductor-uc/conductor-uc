import { Type, defineEvents } from '@cuc/api-contracts';

/**
 * This service's event contracts, domain `call` (`packages/api-contracts/src/subjects.ts`'s
 * `EVENT_DOMAINS`, already reserved for it).
 *
 * Unlike pbx-config-service's "thin event, re-fetch current state" pattern
 * (`pbx.media_asset.finalize_requested`), these carry the actual channel
 * data rather than just an id. There is no queryable "current state" API to
 * re-fetch from here — the Redis registry (04 §3.2) is explicitly ephemeral
 * and not a service boundary other services are meant to call through, and
 * these events ARE cdr-service's (S2-18) primary source for building a CDR,
 * not a pointer to one.
 *
 * Verb names and the event set itself (`created|answered|bridged|held|hungup`)
 * match 06-services.md's own "Emits" line for call-control and 04 §3.2's
 * writer list (`CHANNEL_CREATE`, `CHANNEL_ANSWER`, `CHANNEL_BRIDGE`,
 * `CHANNEL_HOLD`, `CHANNEL_HANGUP_COMPLETE`) exactly — those docs already
 * committed to this shape before this task existed, so this is not a naming
 * choice being made here, just matching what was already decided.
 *
 * Every event beyond `created` carries only `callUuid` + `nodeId` (plus
 * whatever the transition itself adds, e.g. `bridgedTo`), on purpose: a
 * consumer building a CDR timeline keys everything off `callUuid` and reads
 * `occurredAt` off the envelope itself for the state-transition time, rather
 * than this service repeating `tenantId`/`from`/`to` on every event.
 *
 * The tenant does travel on every channel event's envelope (`orgContext.
 * tenantId`) whenever it is known (S5-08): api-gateway's realtime hub routes
 * each event to the tenant's live topics by it, and must not have to remember
 * which tenant a call belonged to.
 */
/** S5-15: what the recording buttons may do on a call (`@cuc/api-contracts`' `RecordingControls`). */
const ControlsSchema = Type.Union([
  Type.Literal('none'),
  Type.Literal('on_demand'),
  Type.Literal('pause'),
]);

/** S5-15: the extension a leg belongs to, when the node vouches for it (`normalize.ts`). */
const ExtensionSchema = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);

export const callEvents = defineEvents({
  'call.channel.created': {
    schemaVersion: 1,
    description: 'A new channel appeared on a FreeSWITCH node (ESL CHANNEL_CREATE).',
    data: Type.Object({
      callUuid: Type.String({ minLength: 1 }),
      nodeId: Type.String({ minLength: 1 }),
      tenantId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      direction: Type.Union([Type.Literal('inbound'), Type.Literal('outbound')]),
      from: Type.String(),
      to: Type.String(),
      /**
       * S5-15, optional (added within schema version 1; a consumer must not require it): the
       * extension this leg belongs to when the node can vouch for it, which is how a person's
       * own live calls are found (never their caller ID alone).
       */
      extension: Type.Optional(ExtensionSchema),
      /** S5-15, optional: what the recording buttons may do on the call, when already known. */
      controls: Type.Optional(ControlsSchema),
    }),
  },
  /**
   * S5-08: the first moment a channel's tenant is known, when its
   * `call.channel.created` could not say (a call from a trunk, whose tenant
   * the dialplan names later; a leg created for a bridge that carries no
   * tenant of its own). Carries the call as it stands, so a live view that
   * routes by tenant sees it start before it sees it change. Sent once per
   * channel, always before the event that revealed the tenant.
   */
  'call.channel.identified': {
    schemaVersion: 1,
    description: "A channel's tenant became known after it was created.",
    data: Type.Object({
      callUuid: Type.String({ minLength: 1 }),
      nodeId: Type.String({ minLength: 1 }),
      tenantId: Type.String({ minLength: 1 }),
      direction: Type.Union([Type.Literal('inbound'), Type.Literal('outbound')]),
      from: Type.String(),
      to: Type.String(),
      state: Type.Union([Type.Literal('ringing'), Type.Literal('answered'), Type.Literal('held')]),
      /** RFC 3339. */
      startedAt: Type.String(),
      answeredAt: Type.Union([Type.String(), Type.Null()]),
      bridgedTo: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      /** `paused` since S5-15. */
      recording: Type.Union([Type.Literal('on'), Type.Literal('off'), Type.Literal('paused')]),
      /** S5-15, optional: as on `call.channel.created`. */
      extension: Type.Optional(ExtensionSchema),
      controls: Type.Optional(ControlsSchema),
    }),
  },
  'call.channel.answered': {
    schemaVersion: 1,
    description: 'A channel was answered (ESL CHANNEL_ANSWER).',
    data: Type.Object({
      callUuid: Type.String({ minLength: 1 }),
      nodeId: Type.String({ minLength: 1 }),
      /**
       * S5-15, optional: what the recording buttons may do, when the channel says it by now
       * (`cuc_rec_controls`, set by the dialplan before the call is answered or bridged).
       */
      controls: Type.Optional(ControlsSchema),
    }),
  },
  'call.channel.bridged': {
    schemaVersion: 1,
    description: 'A channel was bridged to another leg (ESL CHANNEL_BRIDGE).',
    data: Type.Object({
      callUuid: Type.String({ minLength: 1 }),
      nodeId: Type.String({ minLength: 1 }),
      bridgedTo: Type.String({ minLength: 1 }),
      /** S5-15, optional: as on `call.channel.answered` (a flow's hand-off sets it before its bridge). */
      controls: Type.Optional(ControlsSchema),
    }),
  },
  'call.channel.held': {
    schemaVersion: 1,
    description: 'A channel was placed on hold (ESL CHANNEL_HOLD).',
    data: Type.Object({
      callUuid: Type.String({ minLength: 1 }),
      nodeId: Type.String({ minLength: 1 }),
    }),
  },
  'call.channel.unheld': {
    schemaVersion: 1,
    description: 'A held channel was taken off hold (ESL CHANNEL_UNHOLD).',
    data: Type.Object({
      callUuid: Type.String({ minLength: 1 }),
      nodeId: Type.String({ minLength: 1 }),
    }),
  },
  'call.channel.recording_started': {
    schemaVersion: 1,
    description: 'A recording of the channel started (ESL RECORD_START).',
    data: Type.Object({
      callUuid: Type.String({ minLength: 1 }),
      nodeId: Type.String({ minLength: 1 }),
    }),
  },
  'call.channel.recording_stopped': {
    schemaVersion: 1,
    description: 'A recording of the channel stopped (ESL RECORD_STOP).',
    data: Type.Object({
      callUuid: Type.String({ minLength: 1 }),
      nodeId: Type.String({ minLength: 1 }),
    }),
  },
  /**
   * S5-15: the channel's recording was paused (`uuid_record mask`: the paused stretch is silence
   * in the file). FreeSWITCH raises nothing for a mask, so this comes from the `CUSTOM
   * cuc::recording` event that `recording_control.lua` (a feature code) and call-control itself
   * (the console's buttons) fire after masking. `recording_started` or `_resumed` ends it.
   */
  'call.channel.recording_paused': {
    schemaVersion: 1,
    description: "The channel's recording was paused (CUSTOM cuc::recording).",
    data: Type.Object({
      callUuid: Type.String({ minLength: 1 }),
      nodeId: Type.String({ minLength: 1 }),
    }),
  },
  'call.channel.recording_resumed': {
    schemaVersion: 1,
    description: "The channel's paused recording was resumed (CUSTOM cuc::recording).",
    data: Type.Object({
      callUuid: Type.String({ minLength: 1 }),
      nodeId: Type.String({ minLength: 1 }),
    }),
  },
  'call.channel.hungup': {
    schemaVersion: 1,
    description: 'A channel hung up (ESL CHANNEL_HANGUP_COMPLETE).',
    data: Type.Object({
      callUuid: Type.String({ minLength: 1 }),
      nodeId: Type.String({ minLength: 1 }),
      hangupCause: Type.String(),
    }),
  },
  /**
   * S2-13, corrected in G-119 (3): an agent's changes in `mod_callcenter` (ESL `CUSTOM
   * callcenter::info`; header names confirmed live, `normalize.ts`). `agentName` is the
   * `mod_callcenter` identity (`extension_number@tenant_domain`, `callcenterName()` in
   * telephony-config's `xml.ts`); the tenant comes from that domain (org-service), since the event
   * names nothing else. Queue callers joining and leaving are not separate events: a caller's leg
   * becomes `call.channel.queued` and ends with its hangup.
   */
  'call.queue.agent_status_changed': {
    schemaVersion: 1,
    description:
      "An agent's availability changed (mod_callcenter agent-status-change: Available, On " +
      "Break, Logged Out, ...). G-119 (3): the tenant is in orgContext when the agent's domain " +
      "belongs to one, and `extension` is the agent's extension number.",
    data: Type.Object({
      nodeId: Type.String({ minLength: 1 }),
      agentName: Type.String({ minLength: 1 }),
      extension: Type.Optional(Type.String({ minLength: 1 })),
      status: Type.String({ minLength: 1 }),
    }),
  },
  'call.queue.agent_state_changed': {
    schemaVersion: 1,
    description:
      'What an agent is doing changed (mod_callcenter agent-state-change: Waiting, Receiving, ' +
      'In a queue call, ...). Tenant and `extension` as for agent_status_changed.',
    data: Type.Object({
      nodeId: Type.String({ minLength: 1 }),
      agentName: Type.String({ minLength: 1 }),
      extension: Type.Optional(Type.String({ minLength: 1 })),
      state: Type.String({ minLength: 1 }),
    }),
  },
  /**
   * G-119 (3): a leg of a queue call, and which queue: the caller joining it (mod_callcenter
   * member-queue-start) or the agent answering (bridge-agent-start). The live views filter and
   * group by it; the leg keeps it until it ends.
   */
  /** S9-14: a call parked in a lot's slot, for the attendant console's parked calls. */
  'call.channel.parked': {
    schemaVersion: 1,
    description: "A channel is parked in a parking lot's slot (mod_valet_parking).",
    data: Type.Object({
      callUuid: Type.String({ minLength: 1 }),
      nodeId: Type.String({ minLength: 1 }),
      parkingLotId: Type.String({ minLength: 1 }),
      slot: Type.Integer({ minimum: 0 }),
    }),
  },
  'call.channel.unparked': {
    schemaVersion: 1,
    description: 'A parked channel was taken back from its slot, or is gone.',
    data: Type.Object({
      callUuid: Type.String({ minLength: 1 }),
      nodeId: Type.String({ minLength: 1 }),
    }),
  },
  'call.channel.queued': {
    schemaVersion: 1,
    description: "A channel is a leg of a queue's call (mod_callcenter).",
    data: Type.Object({
      callUuid: Type.String({ minLength: 1 }),
      nodeId: Type.String({ minLength: 1 }),
      queueId: Type.String({ minLength: 1 }),
    }),
  },
  /**
   * S4-02 (G-123): an operator drained an FS node (it takes no new calls or leases, for a rolling
   * upgrade) or put it back in service. telephony-config, which owns OpenSIPs' tables, takes the
   * node's dispatcher destination out of rotation or puts it back. Carries the whole state, so a
   * redelivery or a repeated drain is harmless.
   */
  'call.node.drain_changed': {
    schemaVersion: 1,
    description: 'An FS node was drained or returned to service.',
    data: Type.Object({
      nodeId: Type.String({ minLength: 1 }),
      draining: Type.Boolean(),
    }),
  },
  /**
   * S4-12 (G-124): an operator changed an FS node's share of new calls in the operations console.
   * telephony-config writes it to the node's dispatcher row and reloads the dispatcher. The row is
   * the only copy: a weight set here outlives OpenSIPs restarts, and `OPENSIPS_FS_DESTINATION`'s
   * weight only starts a newly listed node.
   */
  'call.node.weight_changed': {
    schemaVersion: 1,
    description: "An FS node's dispatcher weight was changed.",
    data: Type.Object({
      nodeId: Type.String({ minLength: 1 }),
      weight: Type.Integer({ minimum: 1, maximum: 999 }),
    }),
  },
  // `call.lost` (04 §4's failure sequence: a node's calls, abandoned on
  // heartbeat expiry) is deliberately NOT defined here — the plan's own
  // dependency table lists it as S4-04's deliverable ("Failover handling:
  // dialog teardown, call.lost, synthetic CDRs, lease release, Redis
  // rebuild"), which depends on S2-11 existing, not the other way around.
  // This service's heartbeat keys (`redis/registry.ts`) are the primitive
  // S4-04 builds node-death detection on; this task does not add the
  // detection loop itself.
});
