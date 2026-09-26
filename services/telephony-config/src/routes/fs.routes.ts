import type { AffinityRegistry } from '@cuc/affinity';
import type { Database } from '@cuc/db';
import { secretEquals } from '@cuc/crypto';
import { Type, type Server, type Static } from '@cuc/http';
import type { Logger } from '@cuc/logger';
import type { Storage } from '@cuc/storage';
import type { Redis } from 'ioredis';

import { enqueueEvent } from '@cuc/events';

import { fromContextId } from '../context-id.js';
import type { CallControlClient } from '../call-control-client.js';
import { resolveOutboundCallerId, type CallerId } from '../domain/caller-id.js';
import { destinationCountry, normalizeToE164 } from '../domain/e164.js';
import { isOutboundCallAllowed, parseFraudLimits } from '../domain/fraud-limits.js';
import { telephonyEvents } from '../events.js';
import type { OrgClient } from '../org-client.js';
import type { PbxConfigClient } from '../pbx-config-client.js';
import type { RecordingClient, RecordingDirective } from '../recording-client.js';
import { decodeRecordingContext, encodeRecordingContext } from '../recording-context.js';
import type { ExtensionRow, OutboundRouteRow, ReadModelRepo } from '../repo/read-model.repo.js';
import type { CallflowClient } from '../callflow-client.js';
import { nextRoundRobinStart } from '../ring-group-counter.js';
import type { TelephonyConfigDb } from '../schema.js';
import type { VoicemailClient } from '../voicemail-client.js';
import {
  AGENT_LOGIN_FEATURE_CODE,
  AGENT_LOGOUT_FEATURE_CODE,
  buildAgentStatusDialplanDocument,
  buildCallcenterConfigurationDocument,
  buildConferenceDialplanDocument,
  buildCallHandlingDialplanDocument,
  buildDialplanDocument,
  buildDirectoryDocument,
  buildEmergencyDialplanDocument,
  buildFlowDialplanDocument,
  buildOutboundDialplanDocument,
  buildParkDialplanDocument,
  buildQueueDialplanDocument,
  buildRecordingRefusalDocument,
  buildRingGroupDialplanDocument,
  buildVoicemailDialplanDocument,
  callcenterName,
  CONSENT_TONE,
  FEATURE_CODE_DONE_TONE,
  FEATURE_CODE_REFUSED_TONE,
  featureCodeListenLegs,
  FORWARD_HOPS_HEADER,
  injectDialplanActions,
  MAX_FORWARD_HOPS,
  NOT_FOUND_DOCUMENT,
  RECORDING_REFUSAL_CAUSE,
  RECORDING_REFUSAL_TONE,
  RECORDING_UNAVAILABLE_ACTION,
  recordingActions,
  recordingControlsFor,
  recordingFeatureCodeActions,
  recordingSpoolPath,
  type CallcenterAgentEntry,
  type CallcenterQueueEntry,
  type CallHandlingPlan,
  type EmergencyLocationDetail,
  type FallbackTarget,
  type PlanLeg,
  type PlanTarget,
} from '../xml.js';
import type { CallHandlingConfig, CallHandlingDestination } from '../domain/call-handling.js';

/**
 * S2-16: dials the calling extension's own mailbox retrieval menu. An
 * arbitrary choice, not sourced from any spec (docs/decisions.md G-38) —
 * `*97` is a common convention in real-world PBXes, picked for familiarity,
 * nothing more.
 */
const VOICEMAIL_RETRIEVAL_FEATURE_CODE = '*97';

/**
 * S2-10: which of a flow's named entry points a `flow` DID starts at.
 *
 * The `dids` table carries only `destination_type`/`destination_id` (05 §3.3)
 * — there is no column naming an entry point, while S2-09's IR deliberately
 * supports several per flow so one flow can serve e.g. both a "main" and an
 * "after_hours" DID. Until a DID can name one, every `flow` DID starts at
 * this conventional name; a flow whose graph has no such entry point is an
 * honest dialplan miss, logged, not a guess at which other entry to use.
 */
const DEFAULT_FLOW_ENTRY_POINT = 'main';

/** `/fs/flow/:tenantId/:flowId/ir` (S2-10) — `flow_runner.lua`'s own IR fetch. */
const FlowIrParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  flowId: Type.String({ minLength: 1 }),
});

/** `/fs/flow/:tenantId/extension/:extensionId` (S2-10) — the `extension` node's id-to-number lookup. */
const FlowExtensionParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  extensionId: Type.String({ minLength: 1 }),
});

/** `/fs/flow/:tenantId/ring-group/:ringGroupId` (S2-10) — the `ring_group` node's member lookup. */
const FlowRingGroupParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  ringGroupId: Type.String({ minLength: 1 }),
});

/** `/fs/flow/:tenantId/schedule/:scheduleId/open` (S3-10) — the `time_condition` node's own lookup. */
const FlowScheduleParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  scheduleId: Type.String({ minLength: 1 }),
});

/** `/fs/flow/:tenantId/queue/:queueId` (S2-13) — the `queue` node's own resolve-and-acquire lookup. */
const FlowQueueParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  queueId: Type.String({ minLength: 1 }),
});
/**
 * S5-11 (b): what `flow_runner.lua` adds to its extension, ring-group and queue lookups so this
 * service can also decide recording for the target. All optional: a runner that sends none of them
 * gets the plain lookup back, exactly as before.
 */
const FlowRecordingQueryFields = {
  /** The call's own uuid (the flow's channel). Asking for a decision needs it. */
  callUuid: Type.Optional(Type.String({ maxLength: 64 })),
  /** The DID the call came in on (`cuc_did_id`, set by `buildFlowDialplanDocument`). */
  didId: Type.Optional(Type.String({ maxLength: 36 })),
  /** `1` when the call is already being recorded: no second decision, no second recording. */
  recording: Type.Optional(Type.Union([Type.Literal('0'), Type.Literal('1')])),
};
const FlowRecordingQuerySchema = Type.Object({
  ...FlowRecordingQueryFields,
  nodeId: Type.Optional(Type.String({ maxLength: 64 })),
});
type FlowRecordingQuery = Static<typeof FlowRecordingQuerySchema>;

/**
 * S5-11 (b): the recording instruction `flow_runner.lua` carries out when it hands the call on.
 * `record` names the spool file (registered already) and the announcement to play first, if any;
 * `unavailable` means recording-service could not be asked, so the runner flags the call.
 */
/**
 * S5-13: present when the target's rule allows feature codes. The runner arms them before bridging:
 * `bind_meta_app` on `listen`, with `context` as the call's `cuc_rec_ctx`.
 */
interface FlowFeatureCodes {
  readonly featureCodes?: {
    readonly listen: string;
    readonly context: string;
    /** S5-15: what the console's buttons may do on the call (`cuc_rec_controls`). */
    readonly controls: 'on_demand' | 'pause';
  };
}

type FlowRecordingInstruction =
  | ({ readonly action: 'none' } & FlowFeatureCodes)
  | { readonly action: 'unavailable' }
  /** S5-12: the tenant requires recording and it cannot be set up: play `tone`, hang up with `cause`. */
  | { readonly action: 'refuse'; readonly tone: string; readonly cause: string }
  | ({
      readonly action: 'record';
      readonly recordingId: string;
      readonly path: string;
      readonly announcement: string | null;
    } & FlowFeatureCodes);

/** `/fs/recording/:tenantId/control` (S5-13): `recording_control.lua`'s feature-code request. */
const RecordingControlParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });
const RecordingControlBodySchema = Type.Object({
  code: Type.Union([Type.Literal('record'), Type.Literal('pause')]),
  /** The channel owning the call's recording (`cuc_rec_owner`, the A leg). */
  callUuid: Type.String({ minLength: 1, maxLength: 64 }),
  /** `cuc_recording_id` on that channel, when a recording is running. */
  recordingId: Type.Optional(Type.String({ maxLength: 36 })),
  /** `cuc_rec_ctx`: the call's context (`recording-context.ts`). */
  context: Type.String({ minLength: 1, maxLength: 2048 }),
  nodeId: Type.Optional(Type.String({ maxLength: 64 })),
});

/** `/fs/recording/:tenantId/agent-answer` (S5-14): `agent_recording.lua`'s question. */
const AgentAnswerQuerySchema = Type.Object({
  queueId: Type.String({ minLength: 1, maxLength: 36 }),
  /** `cc_agent`: `<extension number>@<tenant domain>`. */
  agent: Type.String({ minLength: 3, maxLength: 320 }),
  /** The caller's channel (the queue member), so the recording is found with the call. */
  callUuid: Type.String({ minLength: 1, maxLength: 64 }),
  nodeId: Type.Optional(Type.String({ maxLength: 64 })),
  didId: Type.Optional(Type.String({ maxLength: 36 })),
});

const FlowQueueQuerySchema = Type.Object({
  /** The flow runner's own `cuc_node_id` — see `handleQueueDial`'s doc comment on why an acquire needs to know who's asking. */
  nodeId: Type.String({ minLength: 1 }),
  ...FlowRecordingQueryFields,
});

/** `/fs/affinity/:tenantId/:kind/:resourceId` (S2-12) — the flow runner's own hairpin-vs-local check. */
const AffinityParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  kind: Type.Union([Type.Literal('queue'), Type.Literal('park'), Type.Literal('conf')]),
  resourceId: Type.String({ minLength: 1 }),
});

/**
 * `/fs/media/:tenantId/:assetId/:rate` (S2-07) — `rate` names which transcoded variant, not a raw Hz value FS would need to parse.
 *
 * The `.wav` forms are what the URLs FS is given actually use (S3-11, found
 * live: `mod_http_cache` keeps the URL's own extension on the file it writes,
 * and FS chooses a file format from that extension — with none, the download
 * succeeds and then "Failed to open HTTP cache file", so a `menu` prompt
 * timed out instantly). The bare forms stay accepted for any URL already out
 * there.
 */
const MediaParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  assetId: Type.String({ minLength: 1 }),
  rate: Type.Union([
    Type.Literal('8k'),
    Type.Literal('16k'),
    Type.Literal('8k.wav'),
    Type.Literal('16k.wav'),
  ]),
});

/** `/fs/voicemail/...` (S2-16) — the Lua voicemail app's own params shapes. */
const VoicemailExtensionParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  extensionId: Type.String({ minLength: 1 }),
});
const VoicemailMailboxParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  mailboxId: Type.String({ minLength: 1 }),
});
const VoicemailMessageParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  mailboxId: Type.String({ minLength: 1 }),
  messageId: Type.String({ minLength: 1 }),
});
const VoicemailCreateMessageBodySchema = Type.Object({
  callerIdName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  callerIdNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
const VoicemailPinBodySchema = Type.Object({ pin: Type.String({ minLength: 1 }) });

/** `/fs/conference-rooms/...` (S2-15) — the Lua conference app's own params/body shapes. */
const ConferenceRoomParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  roomId: Type.String({ minLength: 1 }),
});
const ConferencePinBodySchema = Type.Object({ pin: Type.String({ minLength: 1 }) });

/**
 * The most specific outbound route matching `normalizedNumber` (S2-04):
 * longest `pattern` prefix wins, ties broken by the lower `priority` — the
 * same "longest prefix, then priority" precedence `drouting`'s own
 * `do_routing()` implements downstream. This is a coarse pre-check, not the
 * real routing decision: OpenSIPs' `route{}` (via `do_routing()`) is what
 * actually selects and fails over between gateways once the call gets
 * there. What this needs it for is (1) deciding whether to attempt
 * outbound routing at all, and (2) picking which trunk's `caller_id_policy`
 * feeds the third tier of `resolveOutboundCallerId`.
 */
function findBestOutboundRoute(
  routes: readonly OutboundRouteRow[],
  normalizedNumber: string,
): OutboundRouteRow | undefined {
  let best: OutboundRouteRow | undefined;
  for (const route of routes) {
    if (!normalizedNumber.startsWith(route.pattern)) continue;
    if (
      best === undefined ||
      route.pattern.length > best.pattern.length ||
      (route.pattern.length === best.pattern.length && route.priority < best.priority)
    ) {
      best = route;
    }
  }
  return best;
}

/**
 * `/fs/directory` and `/fs/dialplan` (S1-13; 03 §3.1) — two of the three
 * `mod_xml_curl` bindings `telephony/freeswitch/conf/autoload_configs/xml_curl.conf.xml`
 * points at this service. `/fs/configuration` (the third) is also registered
 * here, but only ever returns the not-found document: nothing in scope
 * through M1 uses `callcenter.conf`/`conference.conf`/`valet_parking.conf`
 * (03 §3.1's own row for it lists features this stage never reaches) — but
 * leaving the binding entirely unhandled means every boot and module reload
 * gets an actual HTTP 404, which mod_xml_curl logs as an *error*, not a
 * miss (confirmed live: `mod_xml_curl.c:319 Received HTTP error 404`). A
 * real 200-with-not-found response is the honest, low-cost fix for that.
 *
 * FS's directory/dialplan XML shapes below (`<user>` nesting, `<context>`
 * naming, the `cacheable` attribute) are verified against a real
 * FreeSWITCH 1.10.12 node, not just the module docs — see this PR's
 * description for the exact commands.
 *
 * `config: { public: true }`, same as `internal.routes.ts`: the caller is a
 * FreeSWITCH node, not a tenant actor, so `permission`/`dataClass` do not
 * apply — gated instead by the shared token FS presents as HTTP Basic auth
 * (`gateway-credentials value="fs-node:$${telephony_config_token}"`), 07 §1's
 * precedent for FS/OpenSIPs since real service-to-service auth does not
 * exist yet.
 *
 * Every response is real `freeswitch/xml`, not JSON — `reply.type('text/xml')`
 * with a hand-built string (`../xml.ts`), never Fastify's schema-driven JSON
 * serializer.
 */

/** `ring_groups.member_extension_ids` is stored as JSON text in this service's own mirror (`schema.ts`'s own comment) — same driver-quirk parsing every other JSON-as-text column in this codebase already handles. */
function parseMemberExtensionIds(value: string): string[] {
  return JSON.parse(value) as string[];
}

/** What `registerFsRoutes` needs to record calls (S5-02). */
export interface RecordingWiring {
  readonly client: RecordingClient;
  /** Where FreeSWITCH writes recordings on its node, which the node uploader watches. */
  readonly spoolDir: string;
}

export function registerFsRoutes(
  app: Server,
  db: Database<TelephonyConfigDb>,
  readModel: ReadModelRepo,
  fsXmlCurlToken: string,
  /** OpenSIPs' SIP listener, e.g. `opensips:5060` — see `xml.ts`'s `buildDialplanDocument`. */
  opensipsSipUri: string,
  logger: Logger,
  /** S2-05: `handleOutboundDial`'s live (uncached) toll-fraud limits lookup — see `org-client.ts`'s own doc comment on why this one isn't cached the way `findCountry`'s result is. */
  orgClient: OrgClient,
  /** S2-06: `handleEmergencyDial`'s live emergency-location lookup (G-1) — which numbers *are* the tenant's emergency numbers is answered by `readModel.findEmergencyRouteForTenant` instead (the local mirror `projection.ts` already keeps current), the same "local read model on the call-setup hot path" story every other dialplan lookup here follows. */
  pbxConfigClient: PbxConfigClient,
  /** S2-07: `/fs/media/:tenantId/:assetId/:rate`'s own byte proxy — see that route's own doc comment for why this fetches bytes directly rather than redirecting. */
  storage: Storage,
  /** S2-16: `/fs/voicemail/...`'s own client into voicemail-service's internal API. */
  voicemailClient: VoicemailClient,
  /** S2-08: `ring-group-counter.ts`'s own `round_robin` counter — `null` when `REDIS_URL` is not configured (tests that never exercise a ring-group DID). */
  redis: Redis | null,
  /** S2-10: `/fs/flow/:tenantId/:flowId/ir`'s own client into callflow-service's internal IR API. */
  callflowClient: CallflowClient,
  /**
   * S2-12 (04 §3.3): a direct read of the same Redis affinity-lease state
   * call-control owns — "OpenSIPs reads the lease with `cachedb_redis`"
   * (the architecture doc's own words for a *different* reader) is the same
   * precedent this follows: a plain lookup needs no HTTP hop through
   * call-control, only agreement on the key shape (`packages/affinity`) and
   * the key prefix (`config.ts`'s own comment on why `REDIS_KEY_PREFIX` must
   * match call-control's). `null` when `REDIS_URL` is not configured, same
   * convention as the `redis` parameter below.
   */
  affinity: AffinityRegistry | null,
  /** S2-13: `handleQueueDial`'s own synchronous affinity-acquire call — the *write* path only call-control can serve (see `affinity`'s own doc comment above on why reads and writes take different routes). */
  callControlClient: CallControlClient,
  /** S2-13: this service's own externally-reachable base URL (`config.ts`'s own doc comment) — used only to build a queue's credentialed `moh-sound` URL. */
  selfUrl: string,
  /**
   * S5-02: recording-service's client and this node fleet's spool directory. `null` (the default)
   * turns recording off entirely, which is what tests that never exercise it get.
   */
  recording: RecordingWiring | null = null,
): void {
  // mod_xml_curl posts `application/x-www-form-urlencoded` (verified live
  // against a real FS node) — Fastify parses JSON and text/plain out of the
  // box but not this, so every field (including the dozens of `Caller-*`/
  // `Hunt-*`/`variable_*` ones a dialplan hunt attaches) needs an explicit
  // parser rather than a new dependency for one line of decoding.
  //
  // Also handles every `/fs/voicemail/...`/`/fs/conference-rooms/.../
  // verify-pin`/etc. request `conference.lua`/`voicemail.lua`/
  // `flow_runner.lua` send: confirmed live (S2-20, G-41/G-43) that
  // `mod_curl`'s own `curl` API command cannot reliably be told to send
  // `Content-Type: application/json` at all (its `content-type <mime>`/
  // `json` options both consume the rest of the argument string as their
  // own literal value rather than combining with `append_headers`, a
  // `mod_curl` limitation this file's own doc comment on `authorized()`
  // has the full detail on) — every one of those scripts' own POST bodies
  // arrives labeled `application/x-www-form-urlencoded` regardless, even
  // though the bytes are genuinely a JSON object literal (`{}`,
  // `{"pin":"1234"}`, ...), never real `key=value&...` form data. A body
  // that starts with `{` after trimming is JSON parsed instead of
  // URL-decoded; `mod_xml_curl`'s own bodies never do (its own fields are
  // always `Caller-*`/`Hunt-*`/`variable_*` keys), so this never
  // misclassifies that path.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        const text = body as string;
        if (text.trimStart().startsWith('{')) {
          done(null, JSON.parse(text));
          return;
        }
        done(null, Object.fromEntries(new URLSearchParams(text)));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  /**
   * Resolves a ring group to its members in the order they should be rung
   * (S2-08).
   *
   * Shared by the `ring_group` DID branch and `/fs/flow/.../ring-group/:id`
   * (S2-10's `ring_group` node) precisely because the ordering *is* the
   * strategy: `round_robin`'s rotation counter lives in Redis so every node
   * in a cluster agrees on whose turn it is, and `random`'s shuffle belongs
   * next to it. Duplicating this for the flow runner would give a call two
   * different notions of "next member" depending on how it arrived.
   *
   * Returns `undefined` when the group is gone or has no resolvable members
   * — an honest miss for the caller to turn into a 404 or a dialplan miss.
   */
  async function resolveRingGroup(
    tenantId: string,
    ringGroupId: string,
  ): Promise<
    | {
        ringGroup: NonNullable<Awaited<ReturnType<typeof readModel.findRingGroupById>>>;
        orderedMembers: NonNullable<Awaited<ReturnType<typeof readModel.findExtensionById>>>[];
      }
    | undefined
  > {
    const ringGroup = await readModel.findRingGroupById(ringGroupId);
    if (ringGroup === undefined) return undefined;

    const memberIds = parseMemberExtensionIds(ringGroup.memberExtensionIds);
    const members = (
      await Promise.all(memberIds.map((id) => readModel.findExtensionById(id)))
    ).filter((extension): extension is NonNullable<typeof extension> => extension !== undefined);
    if (members.length === 0) return undefined;

    let orderedMembers = members;
    if (ringGroup.strategy === 'round_robin') {
      const start =
        redis === null
          ? 0
          : await nextRoundRobinStart(redis, tenantId, ringGroup.id, members.length);
      orderedMembers = [...members.slice(start), ...members.slice(0, start)];
    } else if (ringGroup.strategy === 'random') {
      orderedMembers = [...members];
      for (let i = orderedMembers.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const atI = orderedMembers[i];
        const atJ = orderedMembers[j];
        if (atI === undefined || atJ === undefined) continue;
        orderedMembers[i] = atJ;
        orderedMembers[j] = atI;
      }
    }

    return { ringGroup, orderedMembers };
  }

  /**
   * Two accepted forms, checked against the same `fsXmlCurlToken`.
   *
   * `Authorization: Basic <base64(fs-node:token)>` is what `mod_xml_curl`
   * itself sends (`xml_curl.conf.xml`'s own `gateway-credentials`/
   * `auth-scheme` params) — confirmed live to always work, since
   * `mod_xml_curl` builds it internally via libcurl, not by hand.
   *
   * `X-Fs-Node-Token: <token>` (no scheme, no encoding) is for every
   * Lua-script-originated call instead (`conference.lua`/`voicemail.lua`/
   * `flow_runner.lua`'s own `httpCall`s, via `mod_curl`'s `curl` API
   * command) — confirmed live, the hard way (S2-20, G-41/G-43): that
   * command's own argument parser is not shell-like at all. A header
   * *value* containing a space — exactly what `Basic <token>` always has —
   * gets silently truncated at the space, and chaining more than one
   * `append_headers`/`content-type` option together (the scenario shape
   * `mod_curl`'s own usage string documents as valid,
   * `append_headers <n:v>[|append_headers <n:v>]`) does not actually work
   * in this FreeSWITCH build either — the literal `|...` text ends up
   * appended to the first option's own value instead of starting a second
   * one. A single-token header with no embedded space is the only shape
   * that survives that parser intact, so this is the scheme every
   * Lua-script call uses now, not a Basic-auth workaround.
   */
  function authorized(headers: {
    readonly authorization?: string | undefined;
    readonly 'x-fs-node-token'?: string | string[] | undefined;
  }): boolean {
    const nodeToken = headers['x-fs-node-token'];
    if (
      typeof nodeToken === 'string' &&
      nodeToken !== '' &&
      secretEquals(fsXmlCurlToken, nodeToken)
    ) {
      return true;
    }
    const authorization = headers.authorization;
    if (authorization === undefined) return false;
    const [scheme, encoded] = authorization.split(' ');
    if (scheme !== 'Basic' || encoded === undefined || encoded === '') return false;
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator === -1) return false;
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    return username === 'fs-node' && secretEquals(fsXmlCurlToken, password);
  }

  /**
   * A queue's own credentialed MOH URL (S2-13) — the same `http_cache://`-
   * wrapping-a-Basic-auth-URL shape `flow_runner.lua`'s own `mediaUrl()`
   * builds for playback, just in TS since `callcenter.conf` is static XML
   * this service serves directly, not something the Lua runner constructs
   * per call. `mod_http_cache` fetches it directly, so it must be absolute.
   */
  function mohUrlFor(tenantId: string, mediaAssetId: string): string {
    const base = selfUrl.replace(/^(https?:\/\/)/, `$1fs-node:${fsXmlCurlToken}@`);
    return `http_cache://${base}/fs/media/${tenantId}/${mediaAssetId}/8k.wav`;
  }

  /**
   * `/fs/dialplan`'s emergency branch (S2-06; G-1). Checked *before*
   * `findExtensionByNumber` in the `internal` branch below, not after: a
   * tenant dialing its own emergency number must never be shadowed by a
   * coincidentally-numbered extension (a misconfiguration risk, but
   * emergency reachability outranks it) — G-1's own "direct dial without a
   * prefix" is unconditional, not "unless something else claims the
   * number first."
   *
   * Fires `call.emergency.initiated` (G-1's own notification-hook
   * requirement) in its own short transaction, separate from the read path
   * above it — a failure to enqueue the notification must never block the
   * call itself, so it's caught and logged, not allowed to fail the whole
   * dialplan response.
   */
  async function handleEmergencyDial(
    tenantId: string,
    dialedNumber: string,
    callerContext: string,
    callingNumber: string | undefined,
  ): Promise<string> {
    const domain = await readModel.findDomain(db.kysely, tenantId);
    if (domain === undefined) {
      logger.warn({ tenantId }, 'dialplan: tenant has no projected domain');
      return NOT_FOUND_DOCUMENT;
    }

    const callingExtension =
      callingNumber === undefined || callingNumber === ''
        ? undefined
        : await readModel.findExtensionByNumber(tenantId, callingNumber);

    const callerId: CallerId | null =
      callingExtension === undefined
        ? null
        : { name: callingExtension.callerIdName, number: callingExtension.callerIdNumber };

    // The provisioning gate (pbx-config-service's own `extensions.create`,
    // G-1) guarantees every extension has one — a miss here means the
    // lookup itself failed (unreachable pbx-config-service, or the
    // location was deleted out from under the extension somehow), not that
    // none was ever set. Either way, the call still goes out: a missing
    // *address* is not a reason to refuse an emergency call, only a
    // reason to log it loudly.
    let location: EmergencyLocationDetail | null = null;
    if (callingExtension !== undefined) {
      try {
        const resolved = await pbxConfigClient.findEmergencyLocation(
          tenantId,
          callingExtension.emergencyLocationId,
        );
        if (resolved === undefined) {
          logger.error(
            { tenantId, emergencyLocationId: callingExtension.emergencyLocationId },
            'dialplan: emergency call, but the extension’s own emergency location no longer exists',
          );
        } else {
          location = resolved;
        }
      } catch (error) {
        logger.error(
          { tenantId, error: error instanceof Error ? error.message : String(error) },
          'dialplan: emergency call, but could not fetch the emergency location; proceeding without one',
        );
      }
    } else {
      logger.warn(
        { tenantId, dialedNumber },
        'dialplan: emergency call from an unrecognized extension; proceeding without caller ID or a location',
      );
    }

    const drGroupId = await readModel.findOrCreateDrGroupId(db.kysely, tenantId);

    try {
      await db.kysely.transaction().execute(async (trx) => {
        await enqueueEvent(trx, telephonyEvents, {
          type: 'call.emergency.initiated',
          data: {
            dialedNumber,
            callingExtensionId: callingExtension?.id ?? null,
            emergencyLocationId: callingExtension?.emergencyLocationId ?? null,
          },
          orgContext: { tenantId },
        });
      });
    } catch (error) {
      logger.error(
        { tenantId, error: error instanceof Error ? error.message : String(error) },
        'dialplan: failed to enqueue the emergency-call notification event',
      );
    }

    return buildEmergencyDialplanDocument(
      callerContext,
      dialedNumber,
      domain.fqdn,
      opensipsSipUri,
      tenantId,
      drGroupId,
      callerId,
      location,
    );
  }

  /**
   * `/fs/dialplan`'s outbound-to-PSTN branch (S2-04; 03 §2.1: "request from
   * FS: ... else -> do_routing(...)"). Reached when the `internal`-direction
   * lookup above finds no matching extension for `destinationNumber` — this
   * is the fallback that decides whether it's a real outbound call instead
   * of a plain miss.
   *
   * `variable_sip_from_user` is FreeSWITCH's own auto-exposed channel
   * variable for the From header's user part (a *standard* header, unlike
   * the `X-*` custom ones this file's other branches read via
   * `variable_sip_h_*` — no `_h_` infix for a header FreeSWITCH itself
   * already understands). Since OpenSIPs relays a registered phone's
   * original INVITE to FS unmodified aside from adding its own trusted
   * `X-*` headers (`opensips.cfg.template`'s `is_from_local` branch never
   * rewrites From), this is the calling extension's own dialable number —
   * confirmed live, not assumed, the same discipline every other trusted
   * field in this file follows. A miss here (the SIP username and dialable
   * number have diverged after a renumbering, `schema.ts`'s own comment on
   * why that can happen) degrades to trunk-policy-only caller ID rather
   * than blocking the call.
   */
  /**
   * The tenant-level inputs to any outbound dial, fetched once per call and
   * only when something actually dials out: the tenant's country, and (lazily,
   * and memoized) its live toll-fraud limits. Shared by an ordinary outbound
   * call and by an external call-forward or simultaneous-ring leg, so both go
   * through the identical checks (07 §6).
   */
  interface OutboundPolicy {
    readonly tenantId: string;
    readonly country: string;
    /** `undefined` when they could not be fetched: the caller fails the dial closed. */
    limits(): Promise<ReturnType<typeof parseFraudLimits> | undefined>;
  }

  async function outboundPolicyFor(tenantId: string): Promise<OutboundPolicy | undefined> {
    const country = await readModel.findTenantCountry(tenantId);
    if (country === undefined) {
      logger.info({ tenantId }, 'dialplan: tenant has no known country; cannot normalize outbound');
      return undefined;
    }

    // S2-05 (07 §6: "International calling off by default. Country and
    // prefix allow-lists per tenant."). Fetched live, not cached
    // (`org-client.ts`'s own comment on why) — a genuine failure to reach
    // org-service fails the dial closed, the same as any other lookup
    // miss, not a silent "assume unlimited."
    let memo: Promise<ReturnType<typeof parseFraudLimits> | undefined> | undefined;
    return {
      tenantId,
      country,
      limits: () => {
        memo ??= orgClient.findLimits(tenantId).then(
          (rawLimits) => parseFraudLimits(rawLimits ?? {}),
          (error: unknown) => {
            logger.warn(
              { tenantId, error: error instanceof Error ? error.message : String(error) },
              'dialplan: could not fetch fraud limits; failing the call closed',
            );
            return undefined;
          },
        );
        return memo;
      },
    };
  }

  /** Everything `buildOutboundDialplanDocument` and a forwarded external leg need to place one outbound call. */
  interface OutboundDial {
    readonly normalized: string;
    readonly domainFqdn: string;
    readonly drGroupId: number;
    readonly callerId: CallerId | null;
    readonly maxConcurrentChannels: number | null;
  }

  /**
   * The outbound decision for one destination: normalize to E.164, apply the
   * tenant's toll-fraud policy, pick an outbound route, and resolve caller ID
   * (extension, then a bound DID, then the trunk's policy) for
   * `callingExtension`. `undefined` means the call must not be placed.
   *
   * For an ordinary outbound call `callingExtension` is whoever dialled; for a
   * forward it is the extension that forwards, so a forwarded call presents
   * the forwarder's identity and never the original caller's.
   */
  async function planOutboundDial(
    policy: OutboundPolicy,
    destinationNumber: string,
    callingExtension: ExtensionRow | undefined,
  ): Promise<OutboundDial | undefined> {
    const { tenantId, country } = policy;
    const normalized = normalizeToE164(destinationNumber, country);
    if (normalized === undefined) {
      logger.info({ tenantId, destinationNumber }, 'dialplan: could not normalize to E.164');
      return undefined;
    }

    const limits = await policy.limits();
    if (limits === undefined) return undefined;
    const destCountry = destinationCountry(normalized);
    if (!isOutboundCallAllowed(limits, country, destCountry)) {
      logger.info(
        { tenantId, destCountry, tenantCountry: country },
        'dialplan: international call blocked by tenant policy',
      );
      return undefined;
    }

    const routes = await readModel.findOutboundRoutesForTenant(tenantId);
    const route = findBestOutboundRoute(routes, normalized);
    if (route === undefined) {
      logger.info({ tenantId, normalized }, 'dialplan: no outbound route matches this number');
      return undefined;
    }

    const domain = await readModel.findDomain(db.kysely, tenantId);
    if (domain === undefined) {
      logger.warn({ tenantId }, 'dialplan: tenant has no projected domain');
      return undefined;
    }

    const extensionCallerId: CallerId | null =
      callingExtension === undefined
        ? null
        : { name: callingExtension.callerIdName, number: callingExtension.callerIdNumber };
    const boundDid =
      callingExtension === undefined
        ? undefined
        : await readModel.findDidByDestination(tenantId, callingExtension.id);
    const didCallerId: CallerId | null =
      boundDid === undefined ? null : { name: null, number: boundDid.e164 };

    const primaryTrunk = await readModel.findTrunkById(route.trunkIds[0] ?? '');
    const trunkCallerId: CallerId | null =
      primaryTrunk === undefined
        ? null
        : { name: primaryTrunk.callerIdName, number: primaryTrunk.callerIdNumber };

    return {
      normalized,
      domainFqdn: domain.fqdn,
      drGroupId: await readModel.findOrCreateDrGroupId(db.kysely, tenantId),
      callerId: resolveOutboundCallerId(extensionCallerId, didCallerId, trunkCallerId),
      maxConcurrentChannels: limits.maxConcurrentChannels,
    };
  }

  async function handleOutboundDial(
    body: Record<string, string>,
    tenantId: string,
    destinationNumber: string,
    callerContext: string,
  ): Promise<string> {
    const policy = await outboundPolicyFor(tenantId);
    if (policy === undefined) return NOT_FOUND_DOCUMENT;

    const callingNumber = body['variable_sip_from_user'];
    const callingExtension =
      callingNumber === undefined || callingNumber === ''
        ? undefined
        : await readModel.findExtensionByNumber(tenantId, callingNumber);

    const outbound = await planOutboundDial(policy, destinationNumber, callingExtension);
    if (outbound === undefined) return NOT_FOUND_DOCUMENT;

    return buildOutboundDialplanDocument(
      callerContext,
      destinationNumber,
      outbound.normalized,
      outbound.domainFqdn,
      opensipsSipUri,
      outbound.drGroupId,
      outbound.callerId,
      tenantId,
      outbound.maxConcurrentChannels,
    );
  }

  /**
   * How many forwards a call has already been through, from the header every
   * forwarding leg carries (`FORWARD_HOPS_HEADER`). Missing is 0. A value that
   * is not a plain non-negative integer is treated as the cap, not as 0: the
   * header can be set by anything upstream, and unreadable must not mean
   * "forward freely".
   */
  function forwardHopsOf(body: Record<string, string>): number {
    const raw = body[`variable_sip_h_${FORWARD_HOPS_HEADER}`];
    if (raw === undefined || raw === '') return 0;
    return /^\d{1,3}$/.test(raw) ? Number(raw) : MAX_FORWARD_HOPS;
  }

  /**
   * Whether forwarding must be switched off for this call: it has been
   * forwarded `MAX_FORWARD_HOPS` times already, or (a call from a trunk) it
   * presents one of this tenant's own numbers as caller ID, which is what a
   * forward that went out to the PSTN and came straight back looks like when
   * the carrier does not preserve the hop header. Do not disturb still applies.
   */
  async function forwardingSuppressed(
    body: Record<string, string>,
    tenantId: string,
    fromTrunk: boolean,
    hops: number,
  ): Promise<boolean> {
    if (hops >= MAX_FORWARD_HOPS) {
      logger.warn({ tenantId, hops }, 'dialplan: forward hop cap reached; not forwarding');
      return true;
    }
    if (!fromTrunk) return false;
    const callerNumber = body['Caller-Caller-ID-Number'];
    if (callerNumber === undefined || callerNumber === '') return false;
    const e164 = callerNumber.startsWith('+') ? callerNumber : `+${callerNumber}`;
    const own = await readModel.findDidByE164(tenantId, e164);
    if (own !== undefined) {
      logger.warn(
        { tenantId, didId: own.id },
        'dialplan: caller ID is one of the tenant’s own numbers; treating as a forwarding loop',
      );
      return true;
    }
    return false;
  }

  /**
   * The dialplan for a call to an extension that has call handling saved
   * (parity 1a): do not disturb, forward always, busy / no answer /
   * unreachable, and simultaneous ring. Only reached when a row exists; an
   * extension with none takes the original path in the caller unchanged.
   *
   * A destination that cannot be resolved (an extension since deleted or in
   * another tenant, a mailbox that does not exist, an external number the
   * tenant's policy or outbound routes refuse) is dropped, never guessed at:
   * an unresolvable forward-always leaves the extension ringing, and an
   * unresolvable conditional forward falls back to the extension's own
   * voicemail if it has one. Forwarded internal legs are dialled straight to
   * the phone through OpenSIPs, so the target's own call handling is not
   * applied: forwarding is one level deep, which is what rules out extension
   * loops. External legs go through `planOutboundDial`, the same policy an
   * ordinary outbound call gets, attributed to the tenant and carrying the
   * forwarding extension's caller ID.
   */
  async function handleExtensionWithCallHandling(
    body: Record<string, string>,
    tenantId: string,
    extension: ExtensionRow,
    handling: CallHandlingConfig,
    callerContext: string,
    destinationNumber: string,
    domainFqdn: string,
    fromTrunk: boolean,
  ): Promise<string> {
    const hops = forwardHopsOf(body);
    const suppressed = await forwardingSuppressed(body, tenantId, fromTrunk, hops);

    const ownMailbox = await voicemailClient.findMailboxByExtension(tenantId, extension.id);
    const ownVoicemail: FallbackTarget | null =
      ownMailbox === undefined ? null : { kind: 'voicemail', mailboxId: ownMailbox.id };

    let policyPromise: Promise<OutboundPolicy | undefined> | undefined;
    const placed: { external: OutboundDial | undefined } = { external: undefined };

    async function externalLeg(e164: string): Promise<PlanLeg | undefined> {
      policyPromise ??= outboundPolicyFor(tenantId);
      const policy = await policyPromise;
      if (policy === undefined) return undefined;
      const outbound = await planOutboundDial(policy, e164, extension);
      if (outbound === undefined) return undefined;
      placed.external = outbound;
      return {
        kind: 'external',
        normalizedNumber: outbound.normalized,
        drGroupId: outbound.drGroupId,
        callerId: outbound.callerId,
      };
    }

    async function legFor(d: CallHandlingDestination): Promise<PlanLeg | undefined> {
      if (d.type === 'external') return externalLeg(d.e164);
      if (d.type !== 'extension') return undefined;
      const target = await readModel.findExtensionById(d.extensionId);
      if (target === undefined || target.tenantId !== tenantId || target.id === extension.id) {
        logger.warn(
          { tenantId, extensionId: d.extensionId },
          'call handling: destination extension not found',
        );
        return undefined;
      }
      return { kind: 'internal', number: target.number, forwarded: true };
    }

    async function targetFor(
      d: CallHandlingDestination | null,
    ): Promise<FallbackTarget | undefined> {
      if (d === null || suppressed) return undefined;
      if (d.type === 'voicemail') {
        const id = d.extensionId ?? extension.id;
        if (id === extension.id) return ownVoicemail ?? undefined;
        const owner = await readModel.findExtensionById(id);
        if (owner === undefined || owner.tenantId !== tenantId) return undefined;
        const mailbox = await voicemailClient.findMailboxByExtension(tenantId, owner.id);
        return mailbox === undefined ? undefined : { kind: 'voicemail', mailboxId: mailbox.id };
      }
      const leg = await legFor(d);
      return leg === undefined ? undefined : { kind: 'bridge', legs: [leg] };
    }

    let dnd: PlanTarget | null = null;
    if (handling.dnd) {
      dnd =
        handling.dndAction === 'voicemail' && ownVoicemail !== null
          ? ownVoicemail
          : { kind: 'busy' };
    }

    const forwardAlways = dnd === null ? ((await targetFor(handling.forwardAlways)) ?? null) : null;

    const ringLegs: PlanLeg[] = [{ kind: 'internal', number: extension.number, forwarded: false }];
    if (dnd === null && forwardAlways === null && !suppressed) {
      for (const d of handling.simultaneousRing) {
        const leg = await legFor(d);
        if (leg !== undefined) ringLegs.push(leg);
      }
    }

    const conditional = async (
      d: CallHandlingDestination | null,
    ): Promise<FallbackTarget | null> =>
      dnd !== null || forwardAlways !== null ? null : ((await targetFor(d)) ?? ownVoicemail);
    const onBusy = await conditional(handling.forwardBusy);
    const onNoAnswer = await conditional(handling.forwardNoAnswer);
    const onUnreachable = await conditional(handling.forwardUnreachable);

    const plan: CallHandlingPlan = {
      hops,
      dnd,
      forwardAlways,
      ringLegs,
      ringSeconds: handling.noAnswerSeconds,
      onBusy,
      onNoAnswer,
      onUnreachable,
      maxConcurrentChannels: placed.external?.maxConcurrentChannels ?? null,
    };

    return buildCallHandlingDialplanDocument(
      callerContext,
      destinationNumber,
      domainFqdn,
      opensipsSipUri,
      tenantId,
      plan,
    );
  }

  app.post(
    '/fs/directory',
    // No `schema`: FS posts form-urlencoded, not JSON, and the response is
    // hand-built XML, not TypeBox-validated JSON — nothing here fits
    // Fastify's schema-driven request/response pipeline.
    { config: { public: true } },
    async (request, reply) => {
      if (!authorized(request.headers)) {
        reply.code(401);
        return '';
      }

      const body = request.body as Record<string, string>;
      reply.type('text/xml');
      if (body.section !== 'directory' || body.tag_name !== 'domain' || body.key_name !== 'name') {
        return NOT_FOUND_DOCUMENT;
      }

      const fqdn = body.key_value;
      if (fqdn === undefined || fqdn === '') return NOT_FOUND_DOCUMENT;

      const tenantId = await readModel.findTenantIdByFqdn(fqdn);
      if (tenantId === undefined) return NOT_FOUND_DOCUMENT;

      const extensions = await readModel.listExtensionsForTenant(db.kysely, tenantId);
      return buildDirectoryDocument(fqdn, extensions);
    },
  );

  /**
   * `/fs/dialplan`'s retrieval-feature-code branch (S2-16) — dials the
   * *calling* extension's own mailbox, not any destination number. Checked
   * before the ordinary extension lookup, the same "special case first"
   * pattern `handleEmergencyDial`'s own placement already establishes.
   */
  async function handleVoicemailRetrieval(
    tenantId: string,
    callerContext: string,
    callingNumber: string | undefined,
  ): Promise<string> {
    if (callingNumber === undefined || callingNumber === '') return NOT_FOUND_DOCUMENT;
    const callingExtension = await readModel.findExtensionByNumber(tenantId, callingNumber);
    if (callingExtension === undefined) return NOT_FOUND_DOCUMENT;
    const mailbox = await voicemailClient.findMailboxByExtension(tenantId, callingExtension.id);
    if (mailbox === undefined) return NOT_FOUND_DOCUMENT;
    return buildVoicemailDialplanDocument(
      callerContext,
      VOICEMAIL_RETRIEVAL_FEATURE_CODE,
      'retrieve',
      tenantId,
      mailbox.id,
    );
  }

  /**
   * `/fs/dialplan`'s agent login/logout feature-code branch (S2-13) — same
   * "special case first" placement `handleVoicemailRetrieval` already
   * establishes, and the same "resolve the *calling* extension, not the
   * dialed number" shape. An honest miss (not a rejection) when the caller
   * is not a known agent — dialing `*45`/`*46` from a phone with no agent
   * identity is simply not a feature this extension has.
   */
  async function handleAgentStatusChange(
    tenantId: string,
    callerContext: string,
    callingNumber: string | undefined,
    featureCode: string,
    status: 'Available' | 'Logged Out',
  ): Promise<string> {
    if (callingNumber === undefined || callingNumber === '') return NOT_FOUND_DOCUMENT;
    const callingExtension = await readModel.findExtensionByNumber(tenantId, callingNumber);
    if (callingExtension === undefined) return NOT_FOUND_DOCUMENT;
    const agent = await readModel.findAgentByExtensionId(tenantId, callingExtension.id);
    if (agent === undefined) return NOT_FOUND_DOCUMENT;
    const domain = await readModel.findDomain(db.kysely, tenantId);
    if (domain === undefined) {
      logger.warn({ tenantId }, 'dialplan: tenant has no projected domain');
      return NOT_FOUND_DOCUMENT;
    }
    return buildAgentStatusDialplanDocument(
      callerContext,
      featureCode,
      callcenterName(callingExtension.number, domain.fqdn),
      status,
      tenantId,
      opensipsSipUri,
    );
  }

  /**
   * `/fs/dialplan`'s from-trunk `queue` branch (S2-13; G-25). Unlike
   * `extension`/`ring_group` above, a queue must be *leased* to the node
   * handling this call before `mod_callcenter` has anything loaded for it —
   * `nodeId` (the requesting FS node's own `cuc_node_id`, carried as a query
   * param on the `/fs/dialplan` xml_curl binding, `xml_curl.conf.xml`) is
   * what lets this acquire that lease synchronously, onto the same node,
   * before handing the call to `callcenter`. If the queue turns out to be
   * leased to a *different* node, this is an honest miss today rather than a
   * guess: real cross-node redirection for a DID-mapped pinned resource is
   * OpenSIPs' own `cachedb_redis` read (04 §3.3), not built until S4-05, and
   * with one FS node in the dev stack (S2-19 adds the second) this branch
   * should never actually observe it.
   */
  async function handleQueueDial(
    tenantId: string,
    queueId: string,
    callerContext: string,
    destinationNumber: string,
    domainFqdn: string,
    nodeId: string | undefined,
    /** S5-14: the DID the call came in on, for an agent-scoped recording decision at answer. */
    didId?: string,
  ): Promise<string> {
    if (nodeId === undefined || nodeId === '') {
      logger.warn({ tenantId, queueId }, 'dialplan: queue DID hit with no requesting nodeId');
      return NOT_FOUND_DOCUMENT;
    }
    const queue = await readModel.findQueueById(queueId);
    if (queue === undefined) {
      logger.warn({ queueId }, 'dialplan: DID’s destination queue no longer exists');
      return NOT_FOUND_DOCUMENT;
    }

    let acquired;
    try {
      acquired = await callControlClient.acquireAffinity(tenantId, 'queue', queueId, {
        preferredNodeId: nodeId,
        reloadCommands: ['callcenter_config reload'],
      });
    } catch (error) {
      logger.error(
        { err: error, tenantId, queueId },
        'dialplan: could not reach call-control to acquire the queue’s affinity lease',
      );
      return NOT_FOUND_DOCUMENT;
    }

    if (acquired.nodeId !== nodeId) {
      logger.warn(
        { tenantId, queueId, nodeId, leasedTo: acquired.nodeId },
        'dialplan: queue is leased to a different node; cross-node routing is S4-05’s concern, not this one’s',
      );
      return NOT_FOUND_DOCUMENT;
    }

    return buildQueueDialplanDocument(
      callerContext,
      destinationNumber,
      callcenterName(queueId, domainFqdn),
      tenantId,
      // S5-14: armed only when recording is wired, like every other recording action.
      recording === null ? undefined : { queueId, ...(didId === undefined ? {} : { didId }) },
    );
  }

  /**
   * `/fs/dialplan`'s park/retrieve branch (S2-14) — same "acquire the
   * lease onto the requesting node, then hand off" shape `handleQueueDial`
   * already establishes, over `kind: 'park'` instead of `'queue'`. Unlike a
   * queue, this has no known reload command to send (`valet_parking.conf`'s
   * exact shape is not confidently known, G-48) — `xml_flush_cache` alone
   * (`AffinityManager`'s own default) is what runs.
   */
  async function handleParkDial(
    tenantId: string,
    lot: NonNullable<Awaited<ReturnType<typeof readModel.findParkingLotBySlot>>>,
    slotNumber: number,
    callerContext: string,
    destinationNumber: string,
    nodeId: string | undefined,
  ): Promise<string> {
    if (nodeId === undefined || nodeId === '') {
      logger.warn({ tenantId, lotId: lot.id }, 'dialplan: park dial with no requesting nodeId');
      return NOT_FOUND_DOCUMENT;
    }

    const domain = await readModel.findDomain(db.kysely, tenantId);
    if (domain === undefined) {
      logger.warn({ tenantId }, 'dialplan: tenant has no projected domain');
      return NOT_FOUND_DOCUMENT;
    }

    let acquired;
    try {
      acquired = await callControlClient.acquireAffinity(tenantId, 'park', lot.id, {
        preferredNodeId: nodeId,
      });
    } catch (error) {
      logger.error(
        { err: error, tenantId, lotId: lot.id },
        'dialplan: could not reach call-control to acquire the parking lot’s affinity lease',
      );
      return NOT_FOUND_DOCUMENT;
    }

    if (acquired.nodeId !== nodeId) {
      logger.warn(
        { tenantId, lotId: lot.id, nodeId, leasedTo: acquired.nodeId },
        'dialplan: parking lot is leased to a different node; cross-node routing is S4-05’s concern, not this one’s',
      );
      return NOT_FOUND_DOCUMENT;
    }

    return buildParkDialplanDocument(
      callerContext,
      destinationNumber,
      callcenterName(lot.id, domain.fqdn),
      slotNumber,
      tenantId,
    );
  }

  /**
   * `/fs/dialplan`'s conference-room branch (S2-15) — same "acquire the
   * lease onto the requesting node, then hand off" shape `handleQueueDial`/
   * `handleParkDial` already establish, over `kind: 'conf'`. No reload
   * command: there is no `conference.conf` xml_curl binding for a reload
   * to invalidate (`docs/decisions.md` G-50), so `AffinityManager`'s own
   * default (`xml_flush_cache`) is what runs, the same as parking.
   */
  async function handleConferenceDial(
    tenantId: string,
    room: NonNullable<Awaited<ReturnType<typeof readModel.findConferenceRoomByNumber>>>,
    callerContext: string,
    destinationNumber: string,
    nodeId: string | undefined,
  ): Promise<string> {
    if (nodeId === undefined || nodeId === '') {
      logger.warn(
        { tenantId, roomId: room.id },
        'dialplan: conference dial with no requesting nodeId',
      );
      return NOT_FOUND_DOCUMENT;
    }

    const domain = await readModel.findDomain(db.kysely, tenantId);
    if (domain === undefined) {
      logger.warn({ tenantId }, 'dialplan: tenant has no projected domain');
      return NOT_FOUND_DOCUMENT;
    }

    let acquired;
    try {
      acquired = await callControlClient.acquireAffinity(tenantId, 'conf', room.id, {
        preferredNodeId: nodeId,
      });
    } catch (error) {
      logger.error(
        { err: error, tenantId, roomId: room.id },
        'dialplan: could not reach call-control to acquire the conference room’s affinity lease',
      );
      return NOT_FOUND_DOCUMENT;
    }

    if (acquired.nodeId !== nodeId) {
      logger.warn(
        { tenantId, roomId: room.id, nodeId, leasedTo: acquired.nodeId },
        'dialplan: conference room is leased to a different node; cross-node routing is S4-05’s concern, not this one’s',
      );
      return NOT_FOUND_DOCUMENT;
    }

    return buildConferenceDialplanDocument(
      callerContext,
      destinationNumber,
      tenantId,
      room.id,
      callcenterName(room.id, domain.fqdn),
      room.pinRequired,
    );
  }

  /**
   * What `/fs/dialplan` learned about the call while resolving it, for the recording decision
   * (S5-02). Only the branches that end in a real call fill it in and set `eligible`: emergency,
   * voicemail, conference, parking and agent status calls are never recorded here. A DID to a flow
   * (IVR) is eligible with the DID only (S5-11): tenant and DID rules apply from the flow's answer,
   * and the flow's own hand-off asks again for the extension, ring group or queue it reaches.
   */
  interface RecordingTarget {
    eligible: boolean;
    tenantId?: string;
    direction?: 'inbound' | 'outbound' | 'internal';
    /** The calling extension's number (internal and outbound calls), resolved to an id on demand. */
    callerNumber?: string;
    /** Extension ids already known to be on the call. */
    extensionIds: string[];
    queueId?: string;
    didId?: string;
  }

  /**
   * Asks recording-service about one call. Never throws: `decide` reports its own failures as
   * `unavailable`, and anything else it throws is turned into the same answer (a bug guard).
   */
  async function decideRecording(
    client: RecordingClient,
    call: Parameters<RecordingClient['decide']>[0],
  ): Promise<RecordingDirective> {
    try {
      return await client.decide(call);
    } catch (error) {
      logger.error({ err: error }, 'recording: decision threw; treating it as unavailable');
      return { kind: 'unavailable', reason: 'internal error' };
    }
  }

  /**
   * S5-12: whether a call whose recording decision is unavailable must be refused, because its
   * tenant requires recording. Reads this service's own copy of the flag. If even that local read
   * fails, whether the tenant requires recording cannot be known, so the call goes ahead (the
   * platform default, fail open), logged as an error.
   */
  async function refusesUnrecorded(
    tenantId: string,
    direction: string,
    reason: string,
  ): Promise<boolean> {
    let failClosed: boolean;
    try {
      failClosed = await readModel.findRecordingFailClosed(tenantId);
    } catch (error) {
      logger.error(
        { err: error, tenantId },
        'recording: could not read the tenant’s recording-required flag; placing the call',
      );
      return false;
    }
    if (failClosed) {
      logger.warn(
        { alert: 'recording_required_refused', tenantId, direction, err: reason },
        'recording: the tenant requires recording and it cannot be set up; refusing the call',
      );
    }
    return failClosed;
  }

  /** The announcement to play before a recording starts, or null for none. */
  function announcementFor(
    tenantId: string,
    directive: Extract<RecordingDirective, { kind: 'record' }>,
  ): string | null {
    if (!directive.announce) return null;
    return directive.consentAssetId === null
      ? CONSENT_TONE
      : mohUrlFor(tenantId, directive.consentAssetId);
  }

  /**
   * Adds the recording actions to a call's dialplan document, when a policy asks for one. Never
   * blocks or fails the call: if recording-service cannot be asked, the call is placed unrecorded
   * and flagged (`recording-client.ts` has the full fail-open policy).
   */
  async function withRecording(
    document: string,
    target: RecordingTarget,
    body: Record<string, string>,
    nodeId: string | undefined,
  ): Promise<string> {
    if (
      recording === null ||
      !target.eligible ||
      target.tenantId === undefined ||
      target.direction === undefined ||
      document === NOT_FOUND_DOCUMENT
    ) {
      return document;
    }

    const extensionIds = [...target.extensionIds];
    if (target.callerNumber !== undefined) {
      const caller = await readModel.findExtensionByNumber(target.tenantId, target.callerNumber);
      if (caller !== undefined && !extensionIds.includes(caller.id))
        extensionIds.unshift(caller.id);
    }

    const directive = await decideRecording(recording.client, {
      tenantId: target.tenantId,
      direction: target.direction,
      extensionIds,
      ...(target.queueId === undefined ? {} : { queueId: target.queueId }),
      ...(target.didId === undefined ? {} : { didId: target.didId }),
      callUuid: body['Unique-ID'] ?? body['Channel-Call-UUID'] ?? 'unknown',
      ...(nodeId === undefined || nodeId === '' ? {} : { nodeId }),
    });

    // S5-13: the rule allows feature codes on this call; arm them with the call's context.
    const featureCodes =
      directive.kind !== 'unavailable' && directive.allowOnDemand === true
        ? recordingFeatureCodeActions({
            direction: target.direction,
            recorded: directive.kind === 'record',
            contextToken: encodeRecordingContext({
              tenantId: target.tenantId,
              direction: target.direction,
              extensionIds,
              queueId: target.queueId,
              didId: target.didId,
            }),
          })
        : [];

    if (directive.kind === 'none') {
      return featureCodes.length === 0 ? document : injectDialplanActions(document, featureCodes);
    }
    if (directive.kind === 'unavailable') {
      // S5-12: a tenant that requires recording has its call refused instead of placed
      // unrecorded. The flag is this service's own copy, so it holds while recording-service is
      // down. A decision of "no recording needed" never gets here, so it is never refused.
      if (await refusesUnrecorded(target.tenantId, target.direction, directive.reason)) {
        return buildRecordingRefusalDocument(
          body['Caller-Context'] ?? 'public',
          body['Caller-Destination-Number'] ?? '',
          target.tenantId,
        );
      }
      return injectDialplanActions(document, [RECORDING_UNAVAILABLE_ACTION]);
    }
    return injectDialplanActions(document, [
      ...recordingActions({
        recordingId: directive.recordingId,
        spoolDir: recording.spoolDir,
        announce: directive.announce,
        consentUrl:
          directive.announce && directive.consentAssetId !== null
            ? mohUrlFor(target.tenantId, directive.consentAssetId)
            : null,
      }),
      ...featureCodes,
    ]);
  }

  /**
   * S5-11 (b): the recording decision for the target a flow hands its call to, returned to
   * `flow_runner.lua` with the target itself. The decision is made here with the same engine as
   * `/fs/dialplan` (recording-service's precedence rules); the runner only carries it out.
   *
   * `undefined` when the runner did not ask (no `callUuid`: an older runner) or recording is not
   * wired. `none` without asking when the runner says the call is already being recorded (tenant
   * or DID rules at flow entry, or an earlier hand-off), so a call never gets a second recording.
   * A call through a flow is always inbound: flows are only reached from a DID today.
   */
  async function flowRecordingFor(
    tenantId: string,
    query: FlowRecordingQuery,
    scope: { readonly extensionIds: readonly string[]; readonly queueId?: string },
  ): Promise<FlowRecordingInstruction | undefined> {
    if (recording === null || query.callUuid === undefined || query.callUuid === '') {
      return undefined;
    }
    if (query.recording === '1') return { action: 'none' };

    const didId = query.didId === undefined || query.didId === '' ? undefined : query.didId;
    const nodeId = query.nodeId === undefined || query.nodeId === '' ? undefined : query.nodeId;
    const directive = await decideRecording(recording.client, {
      tenantId,
      direction: 'inbound',
      extensionIds: scope.extensionIds,
      ...(scope.queueId === undefined ? {} : { queueId: scope.queueId }),
      ...(didId === undefined ? {} : { didId }),
      callUuid: query.callUuid,
      ...(nodeId === undefined ? {} : { nodeId }),
    });

    // S5-13: the target's rule allows feature codes; the runner arms them before bridging.
    const featureCodes =
      directive.kind !== 'unavailable' && directive.allowOnDemand === true
        ? {
            featureCodes: {
              listen: featureCodeListenLegs('inbound'),
              // S5-15: `cuc_rec_controls`, which the runner exports next to the codes.
              controls: recordingControlsFor(directive.kind === 'record'),
              context: encodeRecordingContext({
                tenantId,
                direction: 'inbound',
                extensionIds: scope.extensionIds,
                queueId: scope.queueId,
                didId,
              }),
            },
          }
        : {};

    if (directive.kind === 'none') return { action: 'none', ...featureCodes };
    if (directive.kind === 'unavailable') {
      // S5-12: the same refusal as at call setup, carried out by the runner.
      if (await refusesUnrecorded(tenantId, 'inbound', directive.reason)) {
        return { action: 'refuse', tone: RECORDING_REFUSAL_TONE, cause: RECORDING_REFUSAL_CAUSE };
      }
      return { action: 'unavailable' };
    }
    return {
      action: 'record',
      recordingId: directive.recordingId,
      path: recordingSpoolPath(recording.spoolDir, directive.recordingId),
      announcement: announcementFor(tenantId, directive),
      ...featureCodes,
    };
  }

  /**
   * `GET /fs/recording/:tenantId/agent-answer` (S5-14): an agent answered a queue call.
   * `agent_recording.lua` asks from the agent's leg (armed by {@link agentAnswerRecordingActions}),
   * only when the caller is not already being recorded. Decides with the answering agent (an
   * `agent` rule), the queue, the DID and the tenant, registers the recording to the agent's
   * extension, and returns the spool path to record the agent's leg into.
   *
   * `agent` is `mod_callcenter`'s `cc_agent`, `<extension number>@<tenant domain>`: mapped back to
   * the extension here, and only within the tenant that domain belongs to. Fails open without the
   * S5-12 refusal: the caller is already connected to the queue, and refusing the agent's leg would
   * only offer the call to the next agent.
   */
  app.get(
    '/fs/recording/:tenantId/agent-answer',
    {
      config: { public: true },
      schema: { params: RecordingControlParamsSchema, querystring: AgentAnswerQuerySchema },
    },
    async (request, reply) => {
      if (!authorized(request.headers)) {
        reply.code(401);
        return '';
      }
      const { tenantId } = request.params;
      const { queueId, agent, callUuid, nodeId, didId } = request.query;
      const none = { action: 'none' as const };
      if (recording === null) return none;

      const at = agent.lastIndexOf('@');
      const number = at > 0 ? agent.slice(0, at) : '';
      const fqdn = at > 0 ? agent.slice(at + 1) : '';
      if (number === '' || (await readModel.findTenantIdByFqdn(fqdn)) !== tenantId) {
        logger.warn({ tenantId, agent }, 'recording: agent answer for an agent not in this tenant');
        return none;
      }
      const extension = await readModel.findExtensionByNumber(tenantId, number);
      const queue = await readModel.findQueueById(queueId);
      if (extension === undefined || queue === undefined || queue.tenantId !== tenantId) {
        logger.warn({ tenantId, agent, queueId }, 'recording: agent answer did not resolve');
        return none;
      }

      const directive = await decideRecording(recording.client, {
        tenantId,
        direction: 'inbound',
        extensionIds: [],
        queueId,
        ...(didId === undefined || didId === '' ? {} : { didId }),
        agentId: extension.id,
        callUuid,
        ...(nodeId === undefined || nodeId === '' ? {} : { nodeId }),
      });
      if (directive.kind !== 'record') return none;
      return {
        action: 'record' as const,
        recordingId: directive.recordingId,
        path: recordingSpoolPath(recording.spoolDir, directive.recordingId),
      };
    },
  );

  /**
   * `POST /fs/recording/:tenantId/control` (S5-13): a recording feature code pressed during a call,
   * from `recording_control.lua`. FreeSWITCH cannot publish audit events, so the script asks here;
   * this relays to recording-service, which decides with the call's policies, records the change
   * and audits it in one transaction, and only then answers. The answer tells the script what to
   * do on the node (`start`/`stop`/`mask`/`unmask` through `uuid_record`, on the spool path) and
   * which neutral tone to play to whoever pressed. When recording-service cannot answer, nothing
   * happens (`none`): an action that cannot be audited is not taken.
   */
  app.post(
    '/fs/recording/:tenantId/control',
    {
      config: { public: true },
      schema: { params: RecordingControlParamsSchema, body: RecordingControlBodySchema },
    },
    async (request, reply) => {
      if (!authorized(request.headers)) {
        reply.code(401);
        return '';
      }
      const { tenantId } = request.params;
      const { code, callUuid, recordingId, context, nodeId } = request.body;
      const refused = (reason: string) => ({
        action: 'none' as const,
        reason,
        tone: FEATURE_CODE_REFUSED_TONE,
      });

      const decoded = decodeRecordingContext(context);
      if (recording === null || decoded === undefined || decoded.tenantId !== tenantId) {
        logger.warn({ tenantId, callUuid }, 'recording: feature code with no usable call context');
        return refused('no_context');
      }

      let result;
      try {
        result = await recording.client.control({
          tenantId,
          code,
          callUuid,
          ...(recordingId === undefined || recordingId === '' ? {} : { recordingId }),
          ...(nodeId === undefined || nodeId === '' ? {} : { nodeId }),
          context: {
            direction: decoded.direction,
            extensionIds: decoded.extensionIds,
            queueId: decoded.queueId,
            didId: decoded.didId,
          },
        });
      } catch (error) {
        logger.error(
          { err: error, tenantId, callUuid, code },
          'recording: feature code could not reach recording-service; nothing done',
        );
        return refused('unavailable');
      }

      if (result.result === 'refused' || result.recordingId === null) {
        return refused(result.reason ?? 'refused');
      }
      const action = (
        { started: 'start', stopped: 'stop', paused: 'mask', resumed: 'unmask' } as const
      )[result.result];
      return {
        action,
        recordingId: result.recordingId,
        path: recordingSpoolPath(recording.spoolDir, result.recordingId),
        tone: FEATURE_CODE_DONE_TONE,
      };
    },
  );

  app.post('/fs/dialplan', { config: { public: true } }, async (request, reply) => {
    if (!authorized(request.headers)) {
      reply.code(401);
      return '';
    }

    const body = request.body as Record<string, string>;
    // S2-13: the requesting FS node's own `cuc_node_id`, carried as a query
    // param on this binding's `gateway-url` (`xml_curl.conf.xml`) — needed
    // only by the `queue` destination-type branch below, to acquire that
    // queue's affinity lease onto the node that is actually asking.
    const nodeId = (request.query as Record<string, string | undefined>).nodeId;
    reply.type('text/xml');
    const target: RecordingTarget = { eligible: false, extensionIds: [] };
    const document = await resolveDialplan(body, nodeId, target);
    return withRecording(document, target, body, nodeId);
  });

  /** The dialplan document for one `/fs/dialplan` hunt. Fills in `rec` for calls that may be recorded. */
  async function resolveDialplan(
    body: Record<string, string>,
    nodeId: string | undefined,
    rec: RecordingTarget,
  ): Promise<string> {
    if (body.section !== 'dialplan') return NOT_FOUND_DOCUMENT;

    // Trusted signals only (03 §3.2: "Tenant data is never inferred from
    // the context name"): OpenSIPs sets these as custom SIP headers on the
    // leg toward FS, which FreeSWITCH auto-exposes as `sip_h_*` channel
    // variables — confirmed live, not assumed.
    const callDirection = body['variable_sip_h_X-Call-Direction'];
    const destinationNumber = body['Caller-Destination-Number'];
    const callerContext = body['Caller-Context'];

    if (
      destinationNumber === undefined ||
      destinationNumber === '' ||
      callerContext === undefined ||
      callerContext === ''
    ) {
      return NOT_FOUND_DOCUMENT;
    }

    if (callDirection === 'internal') {
      const tenantId = body['variable_sip_h_X-Tenant-Id'];
      if (tenantId === undefined || tenantId === '') return NOT_FOUND_DOCUMENT;

      // G-1: checked first — see `handleEmergencyDial`'s own doc comment on
      // why this must never be shadowed by a same-numbered extension.
      const emergencyRoute = await readModel.findEmergencyRouteForTenant(tenantId);
      if (emergencyRoute !== undefined && emergencyRoute.numbers.includes(destinationNumber)) {
        return handleEmergencyDial(
          tenantId,
          destinationNumber,
          callerContext,
          body['variable_sip_from_user'],
        );
      }

      // S2-16: checked before the ordinary extension lookup — see the
      // handler's own doc comment for why, same placement discipline as G-1's
      // emergency check above.
      if (destinationNumber === VOICEMAIL_RETRIEVAL_FEATURE_CODE) {
        return handleVoicemailRetrieval(tenantId, callerContext, body['variable_sip_from_user']);
      }

      // S2-13: same "special case first" placement as the voicemail
      // retrieval code above.
      if (destinationNumber === AGENT_LOGIN_FEATURE_CODE) {
        return handleAgentStatusChange(
          tenantId,
          callerContext,
          body['variable_sip_from_user'],
          AGENT_LOGIN_FEATURE_CODE,
          'Available',
        );
      }
      if (destinationNumber === AGENT_LOGOUT_FEATURE_CODE) {
        return handleAgentStatusChange(
          tenantId,
          callerContext,
          body['variable_sip_from_user'],
          AGENT_LOGOUT_FEATURE_CODE,
          'Logged Out',
        );
      }

      const extension = await readModel.findExtensionByNumber(tenantId, destinationNumber);
      if (extension === undefined) {
        // S2-15: checked next, before the parking-lot slot range — same
        // "known extension always wins" collision reasoning as the parking
        // lot check below, and a room's own number is a single value
        // (unlike a lot's range), so it can be checked with one exact-match
        // query ahead of it. `docs/decisions.md` G-49: none of extension,
        // conference room, or parking lot cross-checks the others at
        // creation time, so this lookup order is what actually decides a
        // collision, not a rejection at provisioning time.
        const room = await readModel.findConferenceRoomByNumber(tenantId, destinationNumber);
        if (room !== undefined) {
          return handleConferenceDial(tenantId, room, callerContext, destinationNumber, nodeId);
        }

        // S2-14: a known extension always wins a coincidental collision
        // with a parking slot — checked here, after the extension lookup,
        // not before, unlike the feature codes above (which are fixed,
        // well-known short codes; a slot range is admin-configured and can
        // collide with real extension numbers if misconfigured).
        const slotNumber = Number(destinationNumber);
        if (Number.isInteger(slotNumber)) {
          const lot = await readModel.findParkingLotBySlot(tenantId, slotNumber);
          if (lot !== undefined) {
            return handleParkDial(
              tenantId,
              lot,
              slotNumber,
              callerContext,
              destinationNumber,
              nodeId,
            );
          }
        }

        // Not a known extension or parking slot — S2-04: this may still be
        // a real call, just an outbound one to the PSTN, not a rejection.
        // `route{}`'s "request from FS" branch already falls through to
        // `do_routing()` on the exact same signal (a `lookup("location")`
        // miss on this same R-URI) once this response bridges the call
        // back to it.
        Object.assign(rec, {
          eligible: true,
          tenantId,
          direction: 'outbound',
          callerNumber: body['variable_sip_from_user'],
        });
        return handleOutboundDial(body, tenantId, destinationNumber, callerContext);
      }

      // The bridge's R-URI needs the tenant's own SIP domain (`xml.ts`'s own
      // doc comment on why) — not derivable from any trusted request field,
      // so this is the one dialplan lookup that also needs a domain read.
      const domain = await readModel.findDomain(db.kysely, tenantId);
      if (domain === undefined) {
        logger.warn({ tenantId }, 'dialplan: tenant has no projected domain');
        return NOT_FOUND_DOCUMENT;
      }

      // S2-16: a mailbox, if the extension has one, becomes a no-answer/
      // busy fallback rather than a plain hangup — fetched live (the same
      // "not cached, correction takes effect on the next call" reasoning as
      // S2-05's fraud limits and S2-06's emergency location).
      // Parity 1a: an extension with call handling saved takes its own
      // builder; one without is exactly what it was before.
      // S5-02: an extension-to-extension call may be recorded.
      Object.assign(rec, {
        eligible: true,
        tenantId,
        direction: 'internal',
        callerNumber: body['variable_sip_from_user'],
        extensionIds: [extension.id],
      });
      const callHandling = await readModel.findCallHandling(extension.id);
      if (callHandling !== undefined) {
        return handleExtensionWithCallHandling(
          body,
          tenantId,
          extension,
          callHandling,
          callerContext,
          destinationNumber,
          domain.fqdn,
          false,
        );
      }

      const mailbox = await voicemailClient.findMailboxByExtension(tenantId, extension.id);
      return buildDialplanDocument(
        callerContext,
        destinationNumber,
        domain.fqdn,
        opensipsSipUri,
        tenantId,
        destinationNumber,
        mailbox === undefined ? undefined : { tenantId, mailboxId: mailbox.id },
      );
    }

    if (callDirection === 'inbound') {
      // `route{}`'s from-trunk case (S2-03; `opensips.cfg.template`'s
      // `check_source_address` branch) — the trunk's id, `context_info`'s
      // hyphens stripped (03 §2's header-setting story; `context-id.ts`).
      // Trunk identity, not tenant, is what OpenSIPs can actually vouch for
      // here (the `address` table's own row only carries a trunk id) — the
      // owning tenant comes from this service's own already-projected trunk
      // mirror below, not from anything the request itself claims.
      const trunkContextId = body['variable_sip_h_X-Trunk-Id'];
      if (trunkContextId === undefined || trunkContextId === '') return NOT_FOUND_DOCUMENT;

      const trunk = await readModel.findTrunkById(fromContextId(trunkContextId));
      if (trunk === undefined) {
        logger.warn({ trunkContextId }, 'dialplan: no projected trunk for that context id');
        return NOT_FOUND_DOCUMENT;
      }

      // Scoped to the *trunk's* tenant: a DID owned by a different tenant is
      // simply not found here (`did.repo.ts`'s own comment on why
      // `scoped(ctx)` alone gives this for free) — this task's own "Done
      // when": "a DID owned by tenant B that arrives on tenant A's trunk is
      // rejected".
      const did = await readModel.findDidByE164(trunk.tenantId, destinationNumber);
      if (did === undefined) {
        logger.info(
          { tenantId: trunk.tenantId, destinationNumber },
          'dialplan: no DID with that number on this trunk’s tenant',
        );
        return NOT_FOUND_DOCUMENT;
      }

      // Bound to a *different* trunk of the same tenant: still a reject, not
      // just a tenant check (05 §3.3: a DID is bound to one specific trunk).
      if (did.trunkId !== trunk.id) {
        logger.info(
          { didId: did.id, trunkId: trunk.id },
          'dialplan: DID is bound to a different trunk',
        );
        return NOT_FOUND_DOCUMENT;
      }

      // S2-16 (G-25: "each later stage teaches /fs/dialplan to resolve its
      // own destination type") — a DID dialed straight into a mailbox.
      // `destinationId` names the mailbox directly for this destination
      // type (no owning-table referential check exists for it yet, per
      // G-25's own note — same as every other non-extension destination
      // type today).
      if (did.destinationType === 'voicemail') {
        return buildVoicemailDialplanDocument(
          callerContext,
          destinationNumber,
          'leave',
          trunk.tenantId,
          did.destinationId,
        );
      }

      // `extension` (S2-03), `ring_group` (S2-08), `voicemail` (S2-16,
      // returned above), `flow` (S2-10, returned below), `queue` (S2-13,
      // returned below), and `conference` (S2-15, returned below) resolve to
      // a real call — every other destination type still has no owning
      // subsystem (docs/decisions.md G-25), so this is an honest miss, not a
      // guess at behavior only a later stage can define.
      //
      // `ring_group` must stay in this list: the whole ring-group branch
      // below is unreachable without it, which is exactly what broke when
      // #133's merge dropped it — the branch survived, its guard did not,
      // so every ring-group DID silently 404'd.
      if (
        did.destinationType !== 'extension' &&
        did.destinationType !== 'ring_group' &&
        did.destinationType !== 'flow' &&
        did.destinationType !== 'queue' &&
        did.destinationType !== 'conference'
      ) {
        logger.info(
          { didId: did.id, destinationType: did.destinationType },
          'dialplan: DID destination type has no owning subsystem yet',
        );
        return NOT_FOUND_DOCUMENT;
      }

      const domain = await readModel.findDomain(db.kysely, trunk.tenantId);
      if (domain === undefined) {
        logger.warn({ tenantId: trunk.tenantId }, 'dialplan: tenant has no projected domain');
        return NOT_FOUND_DOCUMENT;
      }

      if (did.destinationType === 'extension') {
        const extension = await readModel.findExtensionById(did.destinationId);
        if (extension === undefined) {
          logger.warn(
            { didId: did.id, destinationId: did.destinationId },
            'dialplan: DID’s destination extension no longer exists',
          );
          return NOT_FOUND_DOCUMENT;
        }

        Object.assign(rec, {
          eligible: true,
          tenantId: trunk.tenantId,
          direction: 'inbound',
          didId: did.id,
          extensionIds: [extension.id],
        });
        const callHandling = await readModel.findCallHandling(extension.id);
        if (callHandling !== undefined) {
          return handleExtensionWithCallHandling(
            body,
            trunk.tenantId,
            extension,
            callHandling,
            callerContext,
            destinationNumber,
            domain.fqdn,
            true,
          );
        }

        return buildDialplanDocument(
          callerContext,
          destinationNumber,
          domain.fqdn,
          opensipsSipUri,
          trunk.tenantId,
          extension.number,
        );
      }

      if (did.destinationType === 'flow') {
        // Unlike every other destination type here, a flow has no local
        // mirror in this service to check against — `projection.ts` does not
        // project flows, because the IR is large, versioned, and already
        // served by callflow-service's own internal endpoint. So resolve it
        // over HTTP, the same way the emergency and toll-fraud paths already
        // accept a live lookup on call setup when no mirror exists.
        //
        // Checking here (rather than handing off and letting the runner
        // discover the problem) is what keeps a misconfigured DID an honest,
        // logged dialplan miss instead of dead air on an answered call. The
        // runner re-fetches the IR itself, but normally from its own on-disk
        // cache, so this is one request, not two, on the warm path.
        let published;
        try {
          published = await callflowClient.findPublishedIr(trunk.tenantId, did.destinationId);
        } catch (error) {
          logger.error(
            { err: error, didId: did.id, flowId: did.destinationId },
            'dialplan: could not reach callflow-service to resolve a flow DID',
          );
          return NOT_FOUND_DOCUMENT;
        }

        if (published === undefined) {
          logger.warn(
            { didId: did.id, flowId: did.destinationId },
            'dialplan: DID’s destination flow has no published version',
          );
          return NOT_FOUND_DOCUMENT;
        }
        if (published.ir.entryPoints[DEFAULT_FLOW_ENTRY_POINT] === undefined) {
          logger.warn(
            { didId: did.id, flowId: did.destinationId, entryPoint: DEFAULT_FLOW_ENTRY_POINT },
            'dialplan: DID’s destination flow has no such entry point',
          );
          return NOT_FOUND_DOCUMENT;
        }

        // S5-11 (a): tenant and DID rules apply at flow entry. The recording is armed to start
        // when the flow answers (its first action), so the IVR portion is recorded too.
        Object.assign(rec, {
          eligible: true,
          tenantId: trunk.tenantId,
          direction: 'inbound',
          didId: did.id,
        });
        return buildFlowDialplanDocument(
          callerContext,
          destinationNumber,
          trunk.tenantId,
          did.destinationId,
          DEFAULT_FLOW_ENTRY_POINT,
          domain.fqdn,
          opensipsSipUri,
          did.id,
        );
      }

      if (did.destinationType === 'queue') {
        Object.assign(rec, {
          eligible: true,
          tenantId: trunk.tenantId,
          direction: 'inbound',
          didId: did.id,
          queueId: did.destinationId,
        });
        return handleQueueDial(
          trunk.tenantId,
          did.destinationId,
          callerContext,
          destinationNumber,
          domain.fqdn,
          nodeId,
          did.id,
        );
      }

      if (did.destinationType === 'conference') {
        const room = await readModel.findConferenceRoomById(did.destinationId);
        if (room === undefined) {
          logger.warn(
            { didId: did.id, destinationId: did.destinationId },
            'dialplan: DID’s destination conference room no longer exists',
          );
          return NOT_FOUND_DOCUMENT;
        }
        return handleConferenceDial(trunk.tenantId, room, callerContext, destinationNumber, nodeId);
      }

      // did.destinationType === 'ring_group' (S2-08).
      const resolved = await resolveRingGroup(trunk.tenantId, did.destinationId);
      if (resolved === undefined) {
        logger.warn(
          { didId: did.id, destinationId: did.destinationId },
          'dialplan: DID’s destination ring group did not resolve',
        );
        return NOT_FOUND_DOCUMENT;
      }
      const { ringGroup, orderedMembers } = resolved;
      Object.assign(rec, {
        eligible: true,
        tenantId: trunk.tenantId,
        direction: 'inbound',
        didId: did.id,
      });

      let noAnswerBridgeNumber: string | null = null;
      if (
        ringGroup.noAnswerDestinationType === 'extension' &&
        ringGroup.noAnswerDestinationId !== null
      ) {
        const fallback = await readModel.findExtensionById(ringGroup.noAnswerDestinationId);
        noAnswerBridgeNumber = fallback?.number ?? null;
      }

      return buildRingGroupDialplanDocument(
        callerContext,
        destinationNumber,
        domain.fqdn,
        opensipsSipUri,
        trunk.tenantId,
        orderedMembers.map((extension) => extension.number),
        ringGroup.strategy as 'simultaneous' | 'sequential' | 'round_robin' | 'random',
        ringGroup.ringTimeoutSeconds,
        noAnswerBridgeNumber,
      );
    }

    // Neither ext→ext (S1-13) nor from-trunk (S2-03) — honestly out of scope,
    // not silently guessed at.
    return NOT_FOUND_DOCUMENT;
  }

  /**
   * `GET /fs/media/:tenantId/:assetId/:rate` (S2-07) — what a
   * `http_cache://` URL in a dialplan/IVR document (a future stage's own
   * job: S2-10's `flow_runner.lua`, per the plan's own dependency graph;
   * this task ends at making the resolver itself real) resolves to. FS's
   * own `mod_http_cache` does a plain GET and caches the response on local
   * disk keyed by the URL — "a node restart simply re-caches" (this task's
   * own "Done when") is just that local cache being gone after a restart,
   * nothing this service needs to do anything about.
   *
   * Fetches and returns the transcoded bytes directly (`@cuc/storage`'s
   * `getObject`) rather than the otherwise-more-obvious "302 to a presigned
   * GET URL" — deliberately: whether `mod_http_cache`'s own underlying HTTP
   * client follows redirects at all is not documented anywhere this task
   * found, and this codebase's own hard-won lesson (G-19, G-20, G-24 in
   * docs/decisions.md) is that an unverified assumption about a FreeSWITCH
   * module's real wire behavior is exactly the kind of thing that only
   * surfaces live, expensively. Proxying the bytes needs no such assumption
   * — a plain 200 with a body is unambiguous to any HTTP client — at the
   * cost of this service's own bandwidth for however long a node's local
   * cache takes to warm (S2-07 in scope; a CDN/edge-cache in front of this
   * route is a future scaling concern, not this task's).
   */
  app.get(
    '/fs/media/:tenantId/:assetId/:rate',
    { config: { public: true }, schema: { params: MediaParamsSchema } },
    async (request, reply) => {
      if (!authorized(request.headers)) {
        reply.code(401);
        return '';
      }

      const { tenantId, assetId, rate } = request.params;
      const asset = await pbxConfigClient.findMediaAsset(tenantId, assetId);
      if (asset === undefined || asset.status !== 'ready') {
        logger.info(
          { tenantId, assetId, status: asset?.status },
          'media: asset not found or not ready',
        );
        reply.code(404);
        return '';
      }

      const variantKey = rate.startsWith('8k') ? asset.variant8kKey : asset.variant16kKey;
      if (variantKey === null) {
        // Unreachable in practice — `complete` (pbx-config-service) only
        // ever sets both variant keys together with `status: 'ready'` — but
        // an honest 404 beats trusting that invariant blindly here too.
        logger.error({ tenantId, assetId, rate }, 'media: ready asset missing its own variant key');
        reply.code(404);
        return '';
      }

      let bytes: Buffer;
      try {
        bytes = await storage.forTenant(tenantId).getObject(variantKey);
      } catch (error) {
        logger.error(
          { tenantId, assetId, rate, err: error },
          'media: could not read the transcoded variant from storage',
        );
        reply.code(502);
        return '';
      }

      reply.type('audio/wav');
      return bytes;
    },
  );

  /**
   * `GET /fs/flow/:tenantId/:flowId/ir` (S2-10) — how `flow_runner.lua`
   * fetches a flow's currently published IR over `mod_curl`, gated by the
   * same shared `fs-node` token as every other `/fs/...` route.
   *
   * A thin proxy over `callflowClient` rather than a direct call from the
   * node into callflow-service: CLAUDE.md rule 4's symmetry — only
   * telephony-config talks to FS nodes, and only telephony-config is what FS
   * is configured to call — which also means the node never holds
   * `INTERNAL_SERVICE_TOKEN`.
   *
   * The response is passed through unchanged, version wrapper and all: the
   * runner keys its on-disk cache on `versionNumber`, so stripping it here
   * would break "a published new version takes effect on the next call".
   */
  app.get(
    '/fs/flow/:tenantId/:flowId/ir',
    { config: { public: true }, schema: { params: FlowIrParamsSchema } },
    async (request, reply) => {
      if (!authorized(request.headers)) {
        reply.code(401);
        return '';
      }

      const { tenantId, flowId } = request.params;
      let published;
      try {
        published = await callflowClient.findPublishedIr(tenantId, flowId);
      } catch (error) {
        logger.error({ err: error, tenantId, flowId }, 'flow: could not reach callflow-service');
        reply.code(502);
        return '';
      }

      if (published === undefined) {
        logger.info({ tenantId, flowId }, 'flow: no published version');
        reply.code(404);
        return '';
      }
      return published;
    },
  );

  /**
   * `GET /fs/flow/:tenantId/extension/:extensionId` (S2-10) — the
   * `extension` node's own lookup.
   *
   * The IR names an extension by id (a stable reference that survives a
   * renumber), but a bridge needs the dialable number. The runner resolves
   * it here rather than the IR carrying the number, so a flow published
   * before a renumber still rings the right phone afterwards.
   */
  app.get(
    '/fs/flow/:tenantId/extension/:extensionId',
    {
      config: { public: true },
      schema: { params: FlowExtensionParamsSchema, querystring: FlowRecordingQuerySchema },
    },
    async (request, reply) => {
      if (!authorized(request.headers)) {
        reply.code(401);
        return '';
      }

      const { tenantId, extensionId } = request.params;
      const extension = await readModel.findExtensionById(extensionId);
      if (extension === undefined || extension.tenantId !== tenantId) {
        logger.info({ tenantId, extensionId }, 'flow: extension not found in that tenant');
        reply.code(404);
        return '';
      }
      // S5-11 (b): the extension's own rules (and the DID's and tenant's) decide.
      const recordingInstruction = await flowRecordingFor(tenantId, request.query, {
        extensionIds: [extension.id],
      });
      return {
        number: extension.number,
        ...(recordingInstruction === undefined ? {} : { recording: recordingInstruction }),
      };
    },
  );

  /**
   * `GET /fs/flow/:tenantId/ring-group/:ringGroupId` (S2-10) — the
   * `ring_group` node's own lookup, over the same `resolveRingGroup` the
   * `ring_group` DID branch uses, so a group reached through a flow rings in
   * the same order as one reached directly.
   */
  app.get(
    '/fs/flow/:tenantId/ring-group/:ringGroupId',
    {
      config: { public: true },
      schema: { params: FlowRingGroupParamsSchema, querystring: FlowRecordingQuerySchema },
    },
    async (request, reply) => {
      if (!authorized(request.headers)) {
        reply.code(401);
        return '';
      }

      const { tenantId, ringGroupId } = request.params;
      const resolved = await resolveRingGroup(tenantId, ringGroupId);
      if (resolved === undefined) {
        logger.info({ tenantId, ringGroupId }, 'flow: ring group did not resolve');
        reply.code(404);
        return '';
      }

      // S5-11 (b): there is no ring-group scope, so this is the DID's and tenant's rules — the
      // same decision a DID straight to the ring group gets.
      const recordingInstruction = await flowRecordingFor(tenantId, request.query, {
        extensionIds: [],
      });
      return {
        numbers: resolved.orderedMembers.map((extension) => extension.number),
        strategy: resolved.ringGroup.strategy,
        ringTimeoutSeconds: resolved.ringGroup.ringTimeoutSeconds,
        ...(recordingInstruction === undefined ? {} : { recording: recordingInstruction }),
      };
    },
  );

  /**
   * `GET /fs/flow/:tenantId/schedule/:scheduleId/open` (S3-10, G-59) — the
   * `time_condition` node's own lookup: whether the tenant's schedule is open
   * right now. Evaluated live by pbx-config-service on every call (no cache
   * here), so a schedule edit needs no flow republish, and the node stays
   * stateless. A schedule that no longer exists is a 404, which the runner
   * treats as closed.
   */
  app.get(
    '/fs/flow/:tenantId/schedule/:scheduleId/open',
    { config: { public: true }, schema: { params: FlowScheduleParamsSchema } },
    async (request, reply) => {
      if (!authorized(request.headers)) {
        reply.code(401);
        return '';
      }

      const { tenantId, scheduleId } = request.params;
      const open = await pbxConfigClient.isScheduleOpen(tenantId, scheduleId);
      if (open === undefined) {
        logger.info({ tenantId, scheduleId }, 'flow: schedule did not resolve');
        reply.code(404);
        return '';
      }
      return { open };
    },
  );

  /**
   * `GET /fs/flow/:tenantId/queue/:queueId?nodeId=...` (S2-13) — the flow
   * runner's `queue` node handler. Unlike `/fs/flow/.../extension/:id` and
   * `.../ring-group/:id` (plain lookups), this one has a side effect: it
   * synchronously acquires the queue's affinity lease, preferring the
   * calling node (the same `handleQueueDial` reasoning — a call already
   * running on this node should claim an unleased queue locally rather than
   * being load-balanced elsewhere). The runner uses `isLocal` to decide
   * whether to run `callcenter` itself or hairpin to `nodeId`.
   */
  app.get(
    '/fs/flow/:tenantId/queue/:queueId',
    {
      config: { public: true },
      schema: { params: FlowQueueParamsSchema, querystring: FlowQueueQuerySchema },
    },
    async (request, reply) => {
      if (!authorized(request.headers)) {
        reply.code(401);
        return '';
      }

      const { tenantId, queueId } = request.params;
      const { nodeId } = request.query;

      const queue = await readModel.findQueueById(queueId);
      if (queue === undefined || queue.tenantId !== tenantId) {
        logger.info({ tenantId, queueId }, 'flow: queue not found in that tenant');
        reply.code(404);
        return '';
      }

      const domain = await readModel.findDomain(db.kysely, tenantId);
      if (domain === undefined) {
        logger.warn({ tenantId }, 'flow: tenant has no projected domain');
        reply.code(404);
        return '';
      }

      let acquired;
      try {
        acquired = await callControlClient.acquireAffinity(tenantId, 'queue', queueId, {
          preferredNodeId: nodeId,
          reloadCommands: ['callcenter_config reload'],
        });
      } catch (error) {
        logger.error(
          { err: error, tenantId, queueId },
          'flow: could not reach call-control to acquire the queue’s affinity lease',
        );
        reply.code(502);
        return '';
      }

      // S5-11 (b): only decided when the call stays on this node; a hairpinned call is decided
      // again by the node that runs the queue.
      const isLocal = acquired.nodeId === nodeId;
      const recordingInstruction = isLocal
        ? await flowRecordingFor(tenantId, request.query, { extensionIds: [], queueId })
        : undefined;
      return {
        queueName: callcenterName(queueId, domain.fqdn),
        nodeId: acquired.nodeId,
        isLocal,
        ...(recordingInstruction === undefined ? {} : { recording: recordingInstruction }),
      };
    },
  );

  /**
   * `/fs/voicemail/...` (S2-16) — everything the Lua voicemail app
   * (`telephony/freeswitch/scripts/voicemail.lua`) reaches over `mod_curl`,
   * gated by the same shared `fs-node` token as every other `/fs/...` route.
   * Each handler is a thin proxy over `voicemailClient` into
   * voicemail-service's own internal API — this service never touches
   * voicemail-service's database (05 §1.1).
   *
   * There is no message upload or `complete` route here (S5-16): the Lua
   * app only creates the message row and records to the spool file it
   * names; the node uploader delivers the audio straight to voicemail-service.
   */
  app.get(
    '/fs/voicemail/:tenantId/mailbox/by-extension/:extensionId',
    { config: { public: true }, schema: { params: VoicemailExtensionParamsSchema } },
    async (request, reply) => {
      if (!authorized(request.headers)) {
        reply.code(401);
        return '';
      }
      const { tenantId, extensionId } = request.params;
      const mailbox = await voicemailClient.findMailboxByExtension(tenantId, extensionId);
      if (mailbox === undefined) {
        reply.code(404);
        return '';
      }
      return mailbox;
    },
  );

  app.post(
    '/fs/voicemail/:tenantId/mailbox/:mailboxId/verify-pin',
    {
      config: { public: true },
      schema: { params: VoicemailMailboxParamsSchema, body: VoicemailPinBodySchema },
    },
    async (request, reply) => {
      if (!authorized(request.headers)) {
        reply.code(401);
        return '';
      }
      const { tenantId, mailboxId } = request.params;
      const valid = await voicemailClient.verifyPin(tenantId, mailboxId, request.body.pin);
      return { valid };
    },
  );

  /**
   * `POST /fs/conference-rooms/:tenantId/:roomId/verify-pin` (S2-15) —
   * `conference.lua`'s own PIN check, the same thin-proxy shape as the
   * voicemail verify-pin route above: this service never touches
   * pbx-config-service's database, only its internal API
   * (`pbxConfigClient.verifyConferencePin`).
   */
  app.post(
    '/fs/conference-rooms/:tenantId/:roomId/verify-pin',
    {
      config: { public: true },
      schema: { params: ConferenceRoomParamsSchema, body: ConferencePinBodySchema },
    },
    async (request, reply) => {
      if (!authorized(request.headers)) {
        reply.code(401);
        return '';
      }
      const { tenantId, roomId } = request.params;
      const valid = await pbxConfigClient.verifyConferencePin(tenantId, roomId, request.body.pin);
      return { valid };
    },
  );

  app.post(
    '/fs/voicemail/:tenantId/mailbox/:mailboxId/messages',
    {
      config: { public: true },
      schema: { params: VoicemailMailboxParamsSchema, body: VoicemailCreateMessageBodySchema },
    },
    async (request, reply) => {
      if (!authorized(request.headers)) {
        reply.code(401);
        return '';
      }
      const { tenantId, mailboxId } = request.params;
      const result = await voicemailClient.createMessage(tenantId, mailboxId, request.body);
      return reply.status(201).send(result);
    },
  );

  app.get(
    '/fs/voicemail/:tenantId/mailbox/:mailboxId/messages',
    { config: { public: true }, schema: { params: VoicemailMailboxParamsSchema } },
    async (request, reply) => {
      if (!authorized(request.headers)) {
        reply.code(401);
        return '';
      }
      const { tenantId, mailboxId } = request.params;
      return { rows: await voicemailClient.listMessages(tenantId, mailboxId) };
    },
  );

  app.post(
    '/fs/voicemail/:tenantId/mailbox/:mailboxId/messages/:messageId/mark-read',
    { config: { public: true }, schema: { params: VoicemailMessageParamsSchema } },
    async (request, reply) => {
      if (!authorized(request.headers)) {
        reply.code(401);
        return '';
      }
      const { tenantId, mailboxId, messageId } = request.params;
      return voicemailClient.markMessageRead(tenantId, mailboxId, messageId);
    },
  );

  app.post(
    '/fs/voicemail/:tenantId/mailbox/:mailboxId/messages/:messageId/delete',
    { config: { public: true }, schema: { params: VoicemailMessageParamsSchema } },
    async (request, reply) => {
      if (!authorized(request.headers)) {
        reply.code(401);
        return '';
      }
      const { tenantId, mailboxId, messageId } = request.params;
      await voicemailClient.deleteMessage(tenantId, mailboxId, messageId);
      return reply.status(204).send();
    },
  );

  app.post(
    '/fs/voicemail/:tenantId/mailbox/:mailboxId/greeting/presign',
    { config: { public: true }, schema: { params: VoicemailMailboxParamsSchema } },
    async (request, reply) => {
      if (!authorized(request.headers)) {
        reply.code(401);
        return '';
      }
      const { tenantId, mailboxId } = request.params;
      const result = await voicemailClient.presignGreeting(tenantId, mailboxId);
      return reply.status(201).send(result);
    },
  );

  app.post(
    '/fs/voicemail/:tenantId/mailbox/:mailboxId/greeting/complete',
    { config: { public: true }, schema: { params: VoicemailMailboxParamsSchema } },
    async (request, reply) => {
      if (!authorized(request.headers)) {
        reply.code(401);
        return '';
      }
      const { tenantId, mailboxId } = request.params;
      return voicemailClient.completeGreeting(tenantId, mailboxId);
    },
  );

  /**
   * The playback byte-proxy for a message or the greeting — the exact same
   * "fetch and return bytes directly, don't redirect" reasoning as
   * `/fs/media/...` (S2-07's own doc comment above, unchanged here).
   */
  app.get(
    '/fs/voicemail/:tenantId/mailbox/:mailboxId/messages/:messageId/audio',
    { config: { public: true }, schema: { params: VoicemailMessageParamsSchema } },
    async (request, reply) => {
      if (!authorized(request.headers)) {
        reply.code(401);
        return '';
      }
      const { tenantId, mailboxId, messageId } = request.params;
      const message = await voicemailClient.findMessage(tenantId, mailboxId, messageId);
      if (message === undefined || message.status !== 'ready') {
        reply.code(404);
        return '';
      }
      let bytes: Buffer;
      try {
        bytes = await storage.forTenant(tenantId).getObject(message.objectKey);
      } catch (error) {
        logger.error(
          { tenantId, mailboxId, messageId, err: error },
          'voicemail: could not read message audio',
        );
        reply.code(502);
        return '';
      }
      reply.type('audio/wav');
      return bytes;
    },
  );

  app.get(
    '/fs/voicemail/:tenantId/mailbox/:mailboxId/greeting/audio',
    { config: { public: true }, schema: { params: VoicemailMailboxParamsSchema } },
    async (request, reply) => {
      if (!authorized(request.headers)) {
        reply.code(401);
        return '';
      }
      const { tenantId, mailboxId } = request.params;
      const mailbox = await voicemailClient.findMailbox(tenantId, mailboxId);
      if (
        mailbox === undefined ||
        mailbox.greetingStatus !== 'ready' ||
        mailbox.greetingObjectKey === null
      ) {
        reply.code(404);
        return '';
      }
      let bytes: Buffer;
      try {
        bytes = await storage.forTenant(tenantId).getObject(mailbox.greetingObjectKey);
      } catch (error) {
        logger.error(
          { tenantId, mailboxId, err: error },
          'voicemail: could not read greeting audio',
        );
        reply.code(502);
        return '';
      }
      reply.type('audio/wav');
      return bytes;
    },
  );

  /**
   * S2-13 resolves G-45's own "missing half": `xml_curl.conf.xml`'s
   * `configuration` binding now carries `?nodeId=$${cuc_node_id}` on its
   * `gateway-url`, so this can finally answer "which node is asking" and
   * filter `callcenter.conf` to the queues actually leased to it (04 §3.3).
   * `conference.conf` (S2-15) still falls through to the not-found document
   * — nothing owns that resource kind yet. `valet_parking.conf` (S2-14)
   * also still falls through, but deliberately, not for lack of an owner:
   * a parking lot's own behavior travels inline in the `valet_park(...)`
   * dialplan action itself (`handleParkDial`/`buildParkDialplanDocument`),
   * and this binding's exact XML shape was not confident enough to guess at
   * (G-48) — the affinity mechanics this route exists for are already fully
   * exercised by `callcenter.conf` below.
   *
   * One FS node's `callcenter.conf` can span several tenants at once (each
   * queue's own affinity lease is independent of every other), so this
   * walks `readModel.findAllQueues()` — the one place in this file that
   * deliberately has no single tenant to scope to — rather than a single
   * tenant's queues.
   */
  app.post('/fs/configuration', { config: { public: true } }, async (request, reply) => {
    if (!authorized(request.headers)) {
      reply.code(401);
      return '';
    }
    reply.type('text/xml');

    const body = request.body as Record<string, string>;
    const nodeId = (request.query as Record<string, string | undefined>).nodeId;
    if (body.section !== 'configuration' || body.key_value !== 'callcenter.conf') {
      return NOT_FOUND_DOCUMENT;
    }
    if (nodeId === undefined || nodeId === '' || affinity === null) {
      return NOT_FOUND_DOCUMENT;
    }

    const allQueues = await readModel.findAllQueues();
    const leasedQueues = [];
    for (const queue of allQueues) {
      const owner = await affinity.getOwner({
        tenantId: queue.tenantId,
        kind: 'queue',
        resourceId: queue.id,
      });
      if (owner === nodeId) leasedQueues.push(queue);
    }
    if (leasedQueues.length === 0) return NOT_FOUND_DOCUMENT;

    const domainCache = new Map<string, string | undefined>();
    async function domainFor(tenantId: string): Promise<string | undefined> {
      if (!domainCache.has(tenantId)) {
        const domain = await readModel.findDomain(db.kysely, tenantId);
        domainCache.set(tenantId, domain?.fqdn);
      }
      return domainCache.get(tenantId);
    }

    const queueEntries: CallcenterQueueEntry[] = [];
    const agentEntries = new Map<string, CallcenterAgentEntry>();
    for (const queue of leasedQueues) {
      const domainFqdn = await domainFor(queue.tenantId);
      if (domainFqdn === undefined) {
        logger.warn(
          { tenantId: queue.tenantId, queueId: queue.id },
          'configuration: tenant has no projected domain',
        );
        continue;
      }

      const tiers = await readModel.findQueueTiersForQueue(queue.id);
      const tierEntries: CallcenterQueueEntry['tiers'][number][] = [];
      for (const tier of tiers) {
        const agent = await readModel.findAgentById(tier.agentId);
        if (agent === undefined) continue;
        const extension = await readModel.findExtensionById(agent.extensionId);
        if (extension === undefined) continue;

        const agentName = callcenterName(extension.number, domainFqdn);
        tierEntries.push({ agentName, level: tier.level, position: tier.position });
        agentEntries.set(agentName, {
          name: agentName,
          maxNoAnswer: agent.maxNoAnswer,
          wrapUpSeconds: agent.wrapUpSeconds,
          rejectDelaySeconds: agent.rejectDelaySeconds,
        });
      }

      queueEntries.push({
        name: callcenterName(queue.id, domainFqdn),
        strategy: queue.strategy,
        maxWaitSeconds: queue.maxWaitSeconds,
        mohUrl:
          queue.mohMediaAssetId === null ? null : mohUrlFor(queue.tenantId, queue.mohMediaAssetId),
        tiers: tierEntries,
      });
    }

    return buildCallcenterConfigurationDocument(
      queueEntries,
      [...agentEntries.values()],
      opensipsSipUri,
    );
  });

  /**
   * `GET /fs/affinity/:tenantId/:kind/:resourceId` (S2-12; 04 §3.3) — the
   * flow runner's own hairpin-vs-local check: "if the resource is leased to
   * another node, the runner transfers the call to that node ... Otherwise
   * the runner acquires the lease locally." This route only answers "who
   * holds it right now, if anyone" — the runner compares that against its
   * own `cuc_node_id` (`vars.xml`) to decide which branch it's in; deciding
   * *how* to acquire it locally (which FS reload commands, if any) is each
   * resource kind's own concern (S2-13/14/15), not this route's.
   */
  app.get(
    '/fs/affinity/:tenantId/:kind/:resourceId',
    { config: { public: true }, schema: { params: AffinityParamsSchema } },
    async (request, reply) => {
      if (!authorized(request.headers)) {
        reply.code(401);
        return '';
      }
      if (affinity === null) {
        reply.code(503);
        return '';
      }
      const { tenantId, kind, resourceId } = request.params;
      const nodeId = await affinity.getOwner({ tenantId, kind, resourceId });
      return { nodeId: nodeId ?? null };
    },
  );
}
