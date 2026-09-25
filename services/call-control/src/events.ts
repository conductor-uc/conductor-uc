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
      recording: Type.Union([Type.Literal('on'), Type.Literal('off')]),
    }),
  },
  'call.channel.answered': {
    schemaVersion: 1,
    description: 'A channel was answered (ESL CHANNEL_ANSWER).',
    data: Type.Object({
      callUuid: Type.String({ minLength: 1 }),
      nodeId: Type.String({ minLength: 1 }),
    }),
  },
  'call.channel.bridged': {
    schemaVersion: 1,
    description: 'A channel was bridged to another leg (ESL CHANNEL_BRIDGE).',
    data: Type.Object({
      callUuid: Type.String({ minLength: 1 }),
      nodeId: Type.String({ minLength: 1 }),
      bridgedTo: Type.String({ minLength: 1 }),
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
   * S2-13: an agent's live status changed in `mod_callcenter` (ESL `CUSTOM
   * callcenter::info`, `CC-Action: agent-state-change`) — the only
   * `call.queue.*` event this task wires up. `agentName` is the
   * `mod_callcenter` identity (`extension_number@tenant_domain`,
   * `callcenterName()` in telephony-config's `xml.ts`), not this
   * platform's own agent id: this event has no tenant/agent-id context to
   * carry (ESL reports FS's own config-time identity, nothing else), so a
   * consumer that needs the platform id has to resolve it itself.
   *
   * UNVERIFIED LIVE (docs/decisions.md G-47, same discipline as this
   * codebase's other FS-facing surfaces): `CC-Action`/`CC-Agent`/
   * `CC-Agent-Status` are `mod_callcenter`'s own documented ESL event
   * headers, not invented, but not run against a real FreeSWITCH process.
   * `call.queue.caller_joined`/`call.queue.caller_left` (queue-member add/del) are not
   * implemented — their own header names are less confidently known, and
   * guessing wrong here would silently corrupt event data rather than
   * fail loudly, worse than not emitting them at all.
   */
  'call.queue.agent_status_changed': {
    schemaVersion: 1,
    description: "An agent's live mod_callcenter status changed.",
    data: Type.Object({
      nodeId: Type.String({ minLength: 1 }),
      agentName: Type.String({ minLength: 1 }),
      status: Type.String({ minLength: 1 }),
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
