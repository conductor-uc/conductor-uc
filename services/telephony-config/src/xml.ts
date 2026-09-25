/**
 * `freeswitch/xml` document builders for `/fs/directory` and `/fs/dialplan`
 * (S1-13; 03 §3.1, `docs/architecture/03-signaling-and-media.md`).
 *
 * Verified against a real FreeSWITCH 1.10.12 node (not just the module
 * docs): the wire format is `application/x-www-form-urlencoded` POST,
 * `User-Agent: freeswitch-xml/1.0`, and a miss must be this exact
 * `<result status="not found"/>` shape — an empty body or non-200 status is
 * logged as an *error*, not treated as a miss
 * (developer.signalwire.com/freeswitch/integration/xml-curl).
 */

import { drTag, stripLeadingPlus } from './repo/opensips-projection.repo.js';

/** `mod_callcenter`'s own `<queue name="…">`/`<agent name="…">`/`<tier agent="…" queue="…">` identity convention — `id@domain`, unique within this node the same way a SIP AOR is. Exported for `fs.routes.ts`'s `/fs/configuration` handler, which assembles these across possibly several tenants at once. */
export function callcenterName(id: string, domain: string): string {
  return `${id}@${domain}`;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Escapes PCRE metacharacters (S2-03) — `buildDialplanDocument`'s own
 * `destination_number` condition wraps whatever it's given in `^...$` and
 * FreeSWITCH compiles that as a real regex, not a literal match. An
 * extension number is always plain digits, so this never mattered before,
 * but a DID's E.164 form always leads with a literal `+` — confirmed live:
 * an unescaped `^+15551234567$` fails FreeSWITCH's own regex compile with
 * "COMPILE ERROR: nothing to repeat" (`+` has no preceding atom to quantify)
 * and the call gets no route at all, silently, rather than a clear rejection.
 */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `<action application="set" data="cuc_tenant_id=...">` +
 * `<action application="set" data="cuc_node_id=$${cuc_node_id}">` (S2-18/
 * S2-19) — every dialplan document's own first actions, on every branch.
 *
 * `cuc_tenant_id`: `sip_h_X-Tenant-Id` (`opensips.cfg.template`'s own
 * header, confirmed live) is already a reliable channel variable for an
 * internal-direction call by the time it reaches FS, but an inbound
 * (from-trunk) call carries no such header — so this is the one channel
 * variable every branch can agree to set explicitly, giving cdr-service
 * (`domain/cdr.ts`) a single, direction-independent field to read off
 * `mod_json_cdr`'s own `variables.cuc_tenant_id` rather than needing
 * direction-dependent fallback logic.
 *
 * `cuc_node_id`: confirmed live (S2-19's own two-node verification) that
 * `vars.xml`'s `X-PRE-PROCESS cmd="set" data="cuc_node_id=..."` only
 * defines a *global* variable (resolved by `$${cuc_node_id}` substitution
 * at XML-parse time, and by `session:getVariable`'s own global-variable
 * fallback in Lua) — it is never a *channel* variable unless something
 * explicitly sets it on the channel, and `mod_json_cdr`'s own `variables`
 * dump only ever serializes a channel's own local variable table, not the
 * global pool. Without this action, every CDR's `variables.cuc_node_id`
 * comes back empty and cdr-service rejects the whole payload
 * (`InvalidCdrPayloadError`) — caught live, not theoretical.
 *
 * `buildFlowDialplanDocument` does not call this helper — it already sets
 * `cuc_tenant_id` itself (part of the small set flow_runner.lua reads
 * directly) and separately sets `cuc_node_id` the same way, for the same
 * reason.
 */
function tenantIdAction(tenantId: string): string {
  return (
    `<action application="set" data="${escapeXml(`cuc_tenant_id=${tenantId}`)}"/>\n` +
    '          <action application="set" data="cuc_node_id=$${cuc_node_id}"/>'
  );
}

/**
 * `<action application="set" data="cuc_call_direction=outbound">` (S2-18) —
 * cdr-service's CDR v1 `direction` field (`inbound`/`outbound`/`internal`)
 * does not line up with `X-Call-Direction`'s own two values the way
 * `tenantIdAction` lines up with `X-Tenant-Id`: an outbound-to-PSTN call is
 * still `X-Call-Direction: internal` at the moment OpenSIPs first routes the
 * INVITE to FS (a registered extension's own call) — "outbound" is a purely
 * FS-dialplan-level distinction, decided only once the dialled number fails
 * to resolve internally. So only the two builders that reach that decision
 * (`buildOutboundDialplanDocument`, `buildEmergencyDialplanDocument`) set
 * this override; cdr-service falls back to `X-Call-Direction` for every
 * other call (`docs/decisions.md`'s new G-51 has the full reasoning).
 */
function outboundCallDirectionAction(): string {
  return '<action application="set" data="cuc_call_direction=outbound"/>';
}

export const NOT_FOUND_DOCUMENT =
  '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
  '<document type="freeswitch/xml">\n' +
  '  <section name="result">\n' +
  '    <result status="not found"/>\n' +
  '  </section>\n' +
  '</document>\n';

/**
 * A directory lookup is by domain (confirmed live: `tag_name=domain`,
 * `key_name=name`, `key_value=<fqdn>` — no per-user request ever observed).
 * FreeSWITCH's directory XML nests every known user under the one `<domain>`
 * element, so one response answers the whole domain rather than one user.
 *
 * `cacheable` is FreeSWITCH's *actual* directory cache lever — confirmed
 * directly against `switch_xml.c` (`switch_xml_locate_user_merged`): a
 * `<user>` element's own `cacheable="<ms>"` attribute controls how long
 * *that* node caches it, checked again on every subsequent lookup. There is
 * no HTTP `Cache-Control` equivalent mod_xml_curl honors — 03 §3.1's "short
 * TTL (≤ 30s)" is applied here, not as a response header.
 */
export function buildDirectoryDocument(
  fqdn: string,
  users: readonly { readonly username: string }[],
): string {
  const userElements = users
    .map(
      (user) =>
        `      <user id="${escapeXml(user.username)}" cacheable="30000">\n` +
        '        <params/>\n' +
        '        <variables/>\n' +
        '      </user>',
    )
    .join('\n');

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
    '<document type="freeswitch/xml">\n' +
    '  <section name="directory">\n' +
    `    <domain name="${escapeXml(fqdn)}">\n` +
    `${userElements}\n` +
    '    </domain>\n' +
    '  </section>\n' +
    '</document>\n'
  );
}

/**
 * A `from-ext` ext→ext match (S1-13): one extension, one condition. The
 * `<context>` name echoes back whatever `Caller-Context` the request
 * declared — confirmed live that this node's sofia profile enters every
 * call under `public` (its static `context` param), not a literal
 * `from-ext`, so hard-coding "from-ext" here would never match FreeSWITCH's
 * own dialplan hunt (`switch_core_state_machine.c`: it only executes a
 * `<context>` block whose `name` equals the *current* channel's context).
 * 03 §3.2's three context names are a logical routing table, not literal FS
 * context values this single-profile deployment ever sets — this service
 * makes the real routing decision from the trusted `X-Call-Direction`
 * channel variable instead (03 §3.2: "Tenant data is never inferred from
 * the context name").
 *
 * The bridge target's R-URI stays `<number>@<tenant domain>` — `lookup(
 * "location")` on the OpenSIPs side (`use_domain=1`, S1-14) only finds a
 * registered contact by exactly that (username, domain) pair, never by
 * whatever host the packet was physically addressed to — while
 * `{sip_route_uri=...}` (a FreeSWITCH inline channel-variable prefix, set
 * right before the dial string) is what actually points the *packet* at
 * OpenSIPs (`opensipsSipUri`, e.g. `opensips:5060`), independent of the
 * R-URI. Both pieces were confirmed live to matter, the hard way:
 *  - `${network_addr}` (FreeSWITCH's own "wherever this call arrived from"
 *    channel variable) reflects the *original calling party's* own
 *    advertised address on a real three-hop call, not OpenSIPs' — a bridge
 *    built from it dials the caller's own phone instead of the proxy.
 *  - Using OpenSIPs' address as the R-URI's *domain* (`102@opensips:5060`)
 *    makes `lookup("location")` search for an AOR in a domain named
 *    "opensips" — which has no registered users — instead of the tenant
 *    domain everyone is actually registered under, so it always misses.
 * "Routed back through OpenSIPs for location" (03 §2.1) needs both: the
 * R-URI OpenSIPs can actually resolve, delivered to the address that can
 * resolve it.
 */
export function buildDialplanDocument(
  callerContext: string,
  destinationNumber: string,
  tenantDomain: string,
  opensipsSipUri: string,
  tenantId: string,
  /**
   * The user part actually dialed at the bridge target — S2-03's from-trunk
   * case needs this distinct from `destinationNumber` (matched against the
   * dialed digits, a DID's E.164) when the resolved destination is an
   * extension with a *different* dialable number. Defaults to
   * `destinationNumber` for the ext→ext case, where they are always the same.
   */
  bridgeNumber: string = destinationNumber,
  /**
   * S2-16: when the bridged extension has a mailbox, a no-answer/busy/
   * unreachable leg falls through to the voicemail Lua app instead of just
   * hanging up — `continue_on_fail` is what makes FreeSWITCH proceed to the
   * *next* action on those specific hangup causes rather than ending the
   * call the moment `bridge` fails (a well-documented `mod_dptools`
   * mechanism, not invented here). This exact XML shape is unverified
   * against a real FS node in this task (no live SIPp run) — flagged as
   * G-38 in docs/decisions.md, the same "unverified FS behavior, flagged
   * rather than silently assumed" discipline as G-19/G-20/G-24/G-35/G-36.
   */
  voicemail?: { readonly tenantId: string; readonly mailboxId: string },
): string {
  const target =
    `{sip_route_uri=sip:${opensipsSipUri}}` + `sofia/internal/${bridgeNumber}@${tenantDomain}`;

  const actions = [
    tenantIdAction(tenantId),
    `<action application="bridge" data="${escapeXml(target)}"/>`,
  ];
  if (voicemail !== undefined) {
    actions.unshift(
      '<action application="set" data="hangup_after_bridge=false"/>',
      '<action application="set" data="continue_on_fail=true"/>',
    );
    actions.push(
      `<action application="lua" data="voicemail.lua leave ${escapeXml(voicemail.tenantId)} ${escapeXml(voicemail.mailboxId)}"/>`,
    );
  }

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
    '<document type="freeswitch/xml">\n' +
    '  <section name="dialplan">\n' +
    `    <context name="${escapeXml(callerContext)}">\n` +
    `      <extension name="ext-${escapeXml(destinationNumber)}">\n` +
    `        <condition field="destination_number" expression="${escapeXml(`^${escapeRegex(destinationNumber)}$`)}">\n` +
    actions.map((action) => `          ${action}\n`).join('') +
    '        </condition>\n' +
    '      </extension>\n' +
    '    </context>\n' +
    '  </section>\n' +
    '</document>\n'
  );
}

/**
 * Call recording (S5-02): what the dialplan needs to start one.
 *
 * `fs.routes.ts` asks recording-service (`recording-client.ts`) and hands the answer here; these
 * helpers only turn it into actions, so they stay pure string builders like the rest of this file.
 * They are verified only by the unit tests on the strings, not against a real FreeSWITCH node.
 */
export interface RecordingDialplan {
  readonly recordingId: string;
  /** Node-local spool directory the uploader watches, e.g. `/var/spool/cuc/rec`. */
  readonly spoolDir: string;
  readonly announce: boolean;
  /** A credentialed `http_cache://` URL for the tenant's own consent recording, or null for the neutral tone. */
  readonly consentUrl: string | null;
}

/**
 * A short neutral tone, played when a policy asks for an announcement but no announcement recording
 * was chosen. It carries no words and no name, so nothing can be branded. It is a courtesy signal, not
 * a spoken notice: a tenant that needs a spoken one uploads a media asset and names it in the policy.
 */
export const CONSENT_TONE = 'tone_stream://%(300,150,880);loops=2';

/** The spool file's path. The name is the opaque recording id and nothing else (no tenant, no number). */
export function recordingSpoolPath(spoolDir: string, recordingId: string): string {
  return `${spoolDir.replace(/\/+$/, '')}/${recordingId}.wav`;
}

/**
 * The actions that start a recording, in order: mark the channel, play the announcement first if the
 * policy says so, then arm `record_session` to start, into the spool, when the call is answered.
 *
 * - `pre_answer` lets the caller hear the announcement before the call is answered, without answering
 *   (and so without starting billing on an inbound call that nobody picks up).
 * - `record_session` is not run directly: on a call that is not answered yet, FreeSWITCH pre-answers
 *   the channel to attach the recorder (seen live: `Pre-Answer` right before `record_session`), which
 *   sends 183 early media to the caller before anyone picks up, so the caller hears silence instead of
 *   ringback. `execute_on_answer` runs it at answer instead, so ringing and the announcement are not in
 *   the file either. `RECORD_STEREO` puts each party on its own channel.
 * - `recording_follow_transfer` keeps recording across an attended transfer.
 */
export function recordingActions(recording: RecordingDialplan): string[] {
  const actions = [
    `<action application="set" data="${escapeXml(`cuc_recording_id=${recording.recordingId}`)}"/>`,
  ];
  if (recording.announce) {
    actions.push(
      '<action application="pre_answer"/>',
      `<action application="playback" data="${escapeXml(recording.consentUrl ?? CONSENT_TONE)}"/>`,
    );
  }
  actions.push(
    '<action application="set" data="RECORD_STEREO=true"/>',
    '<action application="set" data="recording_follow_transfer=true"/>',
    `<action application="set" data="${escapeXml(`execute_on_answer=record_session ${recordingSpoolPath(recording.spoolDir, recording.recordingId)}`)}"/>`,
  );
  return actions;
}

/** What the CDR sees when recording-service could not be asked: the call runs, unrecorded, and is flagged. */
export const RECORDING_UNAVAILABLE_ACTION =
  '<action application="set" data="cuc_recording_status=unavailable"/>';

/**
 * S5-12: the neutral signal played before a call is refused because its tenant requires recording
 * and the recording could not be set up. A reorder (fast busy) tone: no words, no name, nothing
 * that can be branded, and a sound callers already read as "this call cannot go through now".
 */
export const RECORDING_REFUSAL_TONE = 'tone_stream://%(250,250,480,620);loops=4';

/**
 * S5-12: the hangup cause for that refusal, the same for every direction. FreeSWITCH sends it as
 * SIP 503 Service Unavailable. That is the honest answer (a platform service is temporarily
 * unavailable, and the call may succeed later), a carrier treats it as "try again or elsewhere",
 * and a phone shows it as a temporary failure rather than a wrong number (404) or a busy line
 * (486). It is never a 403: nothing about the caller is being refused.
 */
export const RECORDING_REFUSAL_CAUSE = 'SERVICE_UNAVAILABLE';

/**
 * S5-12: the whole dialplan document for a refused call: flag the call for the CDR, give early
 * media so the caller hears the tone without the call being answered (no billing on an inbound
 * call, and no 200 OK that would look like a connected call), play the tone, and hang up with
 * {@link RECORDING_REFUSAL_CAUSE}.
 */
export function buildRecordingRefusalDocument(
  callerContext: string,
  destinationNumber: string,
  tenantId: string,
): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
    '<document type="freeswitch/xml">\n' +
    '  <section name="dialplan">\n' +
    `    <context name="${escapeXml(callerContext)}">\n` +
    `      <extension name="recording-required-${escapeXml(destinationNumber)}">\n` +
    `        <condition field="destination_number" expression="${escapeXml(`^${escapeRegex(destinationNumber)}$`)}">\n` +
    `          ${tenantIdAction(tenantId)}\n` +
    '          <action application="set" data="cuc_recording_status=refused"/>\n' +
    '          <action application="pre_answer"/>\n' +
    `          <action application="playback" data="${escapeXml(RECORDING_REFUSAL_TONE)}"/>\n` +
    `          <action application="hangup" data="${RECORDING_REFUSAL_CAUSE}"/>\n` +
    '        </condition>\n' +
    '      </extension>\n' +
    '    </context>\n' +
    '  </section>\n' +
    '</document>\n'
  );
}

/**
 * Puts `actions` at the start of a dialplan document's first `<condition>`. Every builder that
 * places a call emits exactly one, so the actions run before its bridge or hand-off. Returns the
 * document unchanged when there is no condition to put them in.
 */
export function injectDialplanActions(document: string, actions: readonly string[]): string {
  const condition = /<condition [^>]*>\n/.exec(document);
  if (condition === null) return document;
  const at = condition.index + condition[0].length;
  return (
    document.slice(0, at) +
    actions.map((action) => `          ${action}\n`).join('') +
    document.slice(at)
  );
}

/**
 * Parity 1a: per-extension call handling.
 *
 * `fs.routes.ts` resolves what an extension's stored settings mean for one
 * call (which destinations exist, which external ones pass the tenant's
 * toll-fraud policy and have an outbound route, whose caller ID they carry)
 * into a {@link CallHandlingPlan}; this builder only turns a finished plan
 * into XML, so it stays a pure string builder like the rest of this file.
 *
 * Verified only by the unit tests on this string, not against a real
 * FreeSWITCH node (see the report for this feature and G-41). The mechanisms
 * relied on are the same documented ones the voicemail fallback above uses
 * (`continue_on_fail`, then further actions run), plus reading
 * `originate_disposition` (the cause of the bridge that just failed) with
 * nested variable expansion to pick the fallback for that cause.
 */

/** How many times a call may be forwarded onward before forwarding is switched off for it. */
export const MAX_FORWARD_HOPS = 3;

/** The SIP header (and so `sip_h_*` channel variable) carrying the count of forwards a call has been through. Neutral, no branding. */
export const FORWARD_HOPS_HEADER = 'X-Forward-Hops';

/** One thing to ring. */
export type PlanLeg =
  /** A registered phone in the tenant, reached back through OpenSIPs' location lookup. */
  | { readonly kind: 'internal'; readonly number: string; readonly forwarded: boolean }
  /**
   * A PSTN number, dialled exactly as an ordinary outbound call is: tagged
   * with the tenant's routing group (`drTag`) so only that tenant's outbound
   * routes can match, with the caller ID `resolveOutboundCallerId` chose.
   */
  | {
      readonly kind: 'external';
      readonly normalizedNumber: string;
      readonly drGroupId: number;
      readonly callerId: { readonly name: string | null; readonly number: string | null } | null;
    };

/** What happens to the call. A voicemail target is a mailbox id (`voicemail.lua leave`). */
export type PlanTarget =
  | { readonly kind: 'bridge'; readonly legs: readonly PlanLeg[] }
  | { readonly kind: 'voicemail'; readonly mailboxId: string }
  | { readonly kind: 'busy' };

/** What a busy / no-answer / unreachable call falls through to: another ring, or a mailbox. */
export type FallbackTarget = Exclude<PlanTarget, { readonly kind: 'busy' }>;

export interface CallHandlingPlan {
  /** Forwards this call has already been through (0 for a fresh call). */
  readonly hops: number;
  /** Set: the call ends here, in this target, and nothing else is tried. Do not disturb. */
  readonly dnd: PlanTarget | null;
  /** Set: replaces ringing the extension altogether. */
  readonly forwardAlways: PlanTarget | null;
  /** The extension's own leg first, then simultaneous-ring legs. */
  readonly ringLegs: readonly PlanLeg[];
  /** Seconds the primary ring lasts before "no answer"; null leaves the ring untimed. */
  readonly ringSeconds: number | null;
  readonly onBusy: FallbackTarget | null;
  readonly onNoAnswer: FallbackTarget | null;
  readonly onUnreachable: FallbackTarget | null;
  /** `null` is unlimited (`fraud-limits.ts`); applied before any bridge that leaves the platform. */
  readonly maxConcurrentChannels: number | null;
}

/**
 * The `originate_disposition` values each fallback class answers to. What a
 * caller reaches when the extension's phone is not registered here arrives
 * through OpenSIPs' failed location lookup as a 404, which FreeSWITCH reports
 * as UNALLOCATED_NUMBER, not USER_NOT_REGISTERED, so both count as
 * "unreachable". ORIGINATOR_CANCEL (the caller hung up) is deliberately in
 * none of them: a caller who gives up must not be forwarded.
 */
export const BUSY_CAUSES = ['USER_BUSY'] as const;
export const NO_ANSWER_CAUSES = [
  'NO_ANSWER',
  'NO_USER_RESPONSE',
  'RECOVERY_ON_TIMER_EXPIRE',
] as const;
export const UNREACHABLE_CAUSES = [
  'USER_NOT_REGISTERED',
  'UNALLOCATED_NUMBER',
  'NO_ROUTE_DESTINATION',
  'DESTINATION_OUT_OF_ORDER',
  'SUBSCRIBER_ABSENT',
] as const;

function legDialString(
  leg: PlanLeg,
  tenantDomain: string,
  opensipsSipUri: string,
  hops: number,
): string {
  const vars = [`sip_route_uri=sip:${opensipsSipUri}`];
  if (leg.kind === 'external') {
    vars.push(...callerIdVars(leg.callerId));
  }
  if (leg.kind === 'external' || leg.forwarded) {
    vars.push(`sip_h_${FORWARD_HOPS_HEADER}=${String(hops + 1)}`);
  }
  const user =
    leg.kind === 'internal'
      ? leg.number
      : drTag(leg.drGroupId) + stripLeadingPlus(leg.normalizedNumber);
  return `[${vars.join(',')}]sofia/internal/${user}@${tenantDomain}`;
}

const hasExternalLeg = (target: PlanTarget | null): boolean =>
  target?.kind === 'bridge' && target.legs.some((leg) => leg.kind === 'external');

export function buildCallHandlingDialplanDocument(
  callerContext: string,
  destinationNumber: string,
  tenantDomain: string,
  opensipsSipUri: string,
  tenantId: string,
  plan: CallHandlingPlan,
): string {
  const dial = (legs: readonly PlanLeg[], prefix = ''): string =>
    prefix + legs.map((l) => legDialString(l, tenantDomain, opensipsSipUri, plan.hops)).join(',');

  const limitAction =
    plan.maxConcurrentChannels === null
      ? []
      : [
          `<action application="limit" data="${escapeXml(`redis ${tenantId} ${OUTBOUND_CHANNEL_LIMIT_RESOURCE} ${String(plan.maxConcurrentChannels)}`)}"/>`,
        ];

  /** The actions that carry a call to one target and finish there. */
  const finalActions = (target: PlanTarget): string[] => {
    switch (target.kind) {
      case 'busy':
        return ['<action application="hangup" data="USER_BUSY"/>'];
      case 'voicemail':
        return [
          `<action application="lua" data="voicemail.lua leave ${escapeXml(tenantId)} ${escapeXml(target.mailboxId)}"/>`,
        ];
      case 'bridge':
        return [
          ...(hasExternalLeg(target) ? limitAction : []),
          `<action application="bridge" data="${escapeXml(dial(target.legs))}"/>`,
        ];
    }
  };

  const actions: string[] = [
    tenantIdAction(tenantId),
    `<action application="set" data="cuc_forward_hops=${String(plan.hops)}"/>`,
  ];

  if (plan.dnd !== null) {
    actions.push(...finalActions(plan.dnd));
  } else if (plan.forwardAlways !== null) {
    actions.push(...finalActions(plan.forwardAlways));
  } else {
    const classes = (
      [
        { causes: BUSY_CAUSES, target: plan.onBusy },
        { causes: NO_ANSWER_CAUSES, target: plan.onNoAnswer },
        { causes: UNREACHABLE_CAUSES, target: plan.onUnreachable },
      ] as { causes: readonly string[]; target: FallbackTarget | null }[]
    ).filter((c): c is { causes: readonly string[]; target: FallbackTarget } => c.target !== null);

    if (classes.length > 0) {
      actions.push(
        `<action application="set" data="${escapeXml(`continue_on_fail=${classes.flatMap((c) => [...c.causes]).join(',')}`)}"/>`,
      );
    }

    // Fallbacks are stored per cause and picked with
    // `${cuc_cf_${originate_disposition}}` after the bridge fails: a
    // condition on `originate_disposition` would be evaluated when the
    // dialplan is parsed, before any bridge has run.
    let bridgeFallbacks = false;
    let voicemailFallbacks = false;
    for (const { causes, target } of classes) {
      for (const cause of causes) {
        if (target.kind === 'bridge') {
          bridgeFallbacks = true;
          actions.push(
            `<action application="set" data="${escapeXml(`cuc_cf_${cause}=${dial(target.legs)}`)}"/>`,
          );
        } else if (target.kind === 'voicemail') {
          voicemailFallbacks = true;
          actions.push(
            `<action application="set" data="${escapeXml(`cuc_cf_vm_${cause}=leave ${tenantId} ${target.mailboxId}`)}"/>`,
          );
        }
      }
    }

    const timeout =
      plan.ringSeconds !== null && plan.onNoAnswer !== null
        ? `{call_timeout=${String(plan.ringSeconds)}}`
        : '';
    const ringsExternal = plan.ringLegs.some((l) => l.kind === 'external');
    // One channel-limit action per call, before the first bridge that can leave the platform.
    const externalFallback = classes.some((c) => hasExternalLeg(c.target));
    if (ringsExternal || externalFallback) actions.push(...limitAction);

    actions.push(
      `<action application="bridge" data="${escapeXml(dial(plan.ringLegs, timeout))}"/>`,
    );
    if (bridgeFallbacks) {
      actions.push('<action application="bridge" data="${cuc_cf_${originate_disposition}}"/>');
    }
    if (voicemailFallbacks) {
      actions.push(
        '<action application="lua" data="voicemail.lua ${cuc_cf_vm_${originate_disposition}}"/>',
      );
    }
  }

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
    '<document type="freeswitch/xml">\n' +
    '  <section name="dialplan">\n' +
    `    <context name="${escapeXml(callerContext)}">\n` +
    `      <extension name="ext-${escapeXml(destinationNumber)}">\n` +
    `        <condition field="destination_number" expression="${escapeXml(`^${escapeRegex(destinationNumber)}$`)}">\n` +
    actions.map((action) => `          ${action}\n`).join('') +
    '        </condition>\n' +
    '      </extension>\n' +
    '    </context>\n' +
    '  </section>\n' +
    '</document>\n'
  );
}

/**
 * `origination_caller_id_number`/`_name` channel-variable assignments for an
 * originated leg. The values come from admin-editable fields and end up
 * inside a dial string, so anything that could end the value early or start
 * a new variable (`'`, `,`, braces, brackets, `|`, backslash, control
 * characters) is removed from the name, and a number that is not plain
 * dialable characters is dropped.
 */
function callerIdVars(
  callerId: { readonly name: string | null; readonly number: string | null } | null,
): string[] {
  const vars: string[] = [];
  if (callerId?.number !== null && callerId?.number !== undefined) {
    if (/^\+?[0-9]{1,32}$/.test(callerId.number)) {
      vars.push(`origination_caller_id_number=${callerId.number}`);
    }
  }
  if (callerId?.name !== null && callerId?.name !== undefined) {
    // eslint-disable-next-line no-control-regex
    const name = callerId.name.replace(/['\\{}[\]|,\u0000-\u001f]/g, '').trim();
    if (name !== '') vars.push(`origination_caller_id_name='${name}'`);
  }
  return vars;
}

/**
 * S2-16: `voicemail.lua`'s own entry points — a DID dialed directly into a
 * mailbox (`destination_type = 'voicemail'`, G-25's own "each later stage
 * teaches `/fs/dialplan` to resolve its own destination type" — this is
 * that stage for voicemail) or a retrieval feature code dialed from inside
 * a tenant's own domain. `mode` picks which Lua entry point runs; the
 * feature-code digit string itself (`fs.routes.ts`'s own caller) is this
 * task's own choice, not sourced from any spec — flagged in
 * docs/decisions.md (G-38) as unverified/arbitrary, same as the dialplan
 * shape above.
 */
export function buildVoicemailDialplanDocument(
  callerContext: string,
  destinationNumber: string,
  mode: 'leave' | 'retrieve',
  tenantId: string,
  mailboxId: string,
): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
    '<document type="freeswitch/xml">\n' +
    '  <section name="dialplan">\n' +
    `    <context name="${escapeXml(callerContext)}">\n` +
    `      <extension name="voicemail-${escapeXml(destinationNumber)}">\n` +
    `        <condition field="destination_number" expression="${escapeXml(`^${escapeRegex(destinationNumber)}$`)}">\n` +
    `          ${tenantIdAction(tenantId)}\n` +
    `          <action application="lua" data="voicemail.lua ${mode} ${escapeXml(tenantId)} ${escapeXml(mailboxId)}"/>\n` +
    '        </condition>\n' +
    '      </extension>\n' +
    '    </context>\n' +
    '  </section>\n' +
    '</document>\n'
  );
}

/**
 * S2-10: hands a call off to `flow_runner.lua`, the auto-attendant/call-flow
 * interpreter. Reached two ways, both of which land here:
 *
 *   - a DID whose `destination_type` is `flow` (G-25's "each later stage
 *     teaches `/fs/dialplan` to resolve its own destination type" — this is
 *     that stage for `flow`), and
 *   - a tenant-internal entry point dialed from `from-ext`.
 *
 * The runner needs the tenant's own SIP domain and the OpenSIPs route URI to
 * bridge `extension`/`ring_group` nodes back out through the edge, exactly
 * the way `buildDialplanDocument` does. Rather than teach the Lua script to
 * look those up over HTTP on every call, they are set here as channel
 * variables — the script reads them with `session:getVariable`. That keeps
 * the runner's per-call HTTP traffic down to the one IR fetch it genuinely
 * needs, and keeps "what domain does this tenant use" a projection concern in
 * this service, where it already lives.
 *
 * `answer` runs before the script: every MVP node either plays audio or
 * collects DTMF, both of which need early media established, and answering
 * once here is simpler to reason about than making each node answer lazily.
 */
export function buildFlowDialplanDocument(
  callerContext: string,
  destinationNumber: string,
  tenantId: string,
  flowId: string,
  entryPoint: string,
  tenantDomain: string,
  opensipsSipUri: string,
  /**
   * S5-11: the DID the call came in on. The runner passes it back when it hands the call to an
   * extension, ring group or queue, so the recording decision there still sees the DID's rules.
   */
  didId?: string,
): string {
  const vars: readonly (readonly [string, string])[] = [
    ['cuc_tenant_id', tenantId],
    ['cuc_tenant_domain', tenantDomain],
    ['cuc_opensips_sip_uri', opensipsSipUri],
    // S2-19: confirmed live that this must be set explicitly as a channel
    // variable, not just the global one `vars.xml` already defines —
    // `tenantIdAction`'s own doc comment (this file) has the full story.
    ['cuc_node_id', '$${cuc_node_id}'],
    ...(didId === undefined ? [] : [['cuc_did_id', didId] as const]),
  ];

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
    '<document type="freeswitch/xml">\n' +
    '  <section name="dialplan">\n' +
    `    <context name="${escapeXml(callerContext)}">\n` +
    `      <extension name="flow-${escapeXml(destinationNumber)}">\n` +
    `        <condition field="destination_number" expression="${escapeXml(`^${escapeRegex(destinationNumber)}$`)}">\n` +
    vars
      .map(
        ([name, value]) =>
          `          <action application="set" data="${escapeXml(`${name}=${value}`)}"/>\n`,
      )
      .join('') +
    '          <action application="answer"/>\n' +
    `          <action application="lua" data="flow_runner.lua ${escapeXml(tenantId)} ${escapeXml(flowId)} ${escapeXml(entryPoint)}"/>\n` +
    '        </condition>\n' +
    '      </extension>\n' +
    '    </context>\n' +
    '  </section>\n' +
    '</document>\n'
  );
}

/**
 * A `from-ext` outbound-to-PSTN match (S2-04; 03 §2.1's "request from FS:
 * ... else -> do_routing(group = tenant's dr group)"). The condition matches
 * `destinationNumber` exactly as the extension dialed it (whatever
 * FreeSWITCH itself reports as `Caller-Destination-Number`) — the bridge
 * target's user part is `normalizedNumber`, the tenant-country-normalized
 * E.164 form (`domain/e164.ts`), since that is what a carrier gateway and
 * `drouting`'s own prefix matching both expect.
 *
 * The bridge target's domain stays the tenant's own SIP domain, the same
 * "route back through OpenSIPs for a decision it alone can make" pattern
 * `buildDialplanDocument`'s own comment explains — `lookup("location")`
 * will miss (a PSTN number is never a registered AOR), which is exactly
 * the trigger `route{}`'s outbound branch needs to fall through to
 * `do_routing()` instead of a plain 404.
 *
 * `X-Dr-Group-Id` is a custom header set here, not looked up by OpenSIPs
 * from any DB table (`opensips-schema.ts`'s own comment on why): the FROM
 * identity on this FS-originated leg is not guaranteed to be a real
 * registered subscriber's own AOR, so `drouting`'s built-in (username,
 * domain)-keyed group auto-detection cannot be trusted the way it can for
 * an inbound REGISTER. This service already knows the tenant's own
 * `dr_group_id` (`read-model.repo.ts`'s `findOrCreateDrGroupId`) at the
 * moment it builds this document, so it hands it over explicitly instead.
 *
 * `origination_caller_id_name`/`_number` are FreeSWITCH's own standard
 * channel-variable-prefix keys for setting the caller identity on an
 * originated leg — unlike `X-Dr-Group-Id`, a well-documented mechanism, not
 * something this task had to invent.
 */
/** `limit`'s own `realm`/`id` pair (mod_dptools) the per-tenant outbound concurrent-channel counter is keyed on — `redis` backend (S2-05; `telephony/freeswitch/conf/autoload_configs/redis.conf.xml`). */
const OUTBOUND_CHANNEL_LIMIT_RESOURCE = 'outbound-channels';

export function buildOutboundDialplanDocument(
  callerContext: string,
  destinationNumber: string,
  normalizedNumber: string,
  tenantDomain: string,
  opensipsSipUri: string,
  drGroupId: number,
  callerId: { readonly name: string | null; readonly number: string | null } | null,
  tenantId: string,
  /** `null` means unlimited (`fraud-limits.ts`'s own convention) — no `limit` action is emitted at all. */
  maxConcurrentChannels: number | null,
): string {
  const vars: string[] = [`sip_route_uri=sip:${opensipsSipUri}`, ...callerIdVars(callerId)];

  // G-28/G-29 (docs/decisions.md): `do_routing()`'s own `groupID` param
  // turned out to be compile-time-only, so there is no way to hand
  // OpenSIPs a per-call tenant group id through a header/AVP any more —
  // tenant isolation instead rides along in `$rU` itself, as a fixed-width
  // tag ahead of the dialed digits (`opensips-projection.repo.ts`'s
  // `drTag`/`DR_TAG_WIDTH`, mirrored by `dr_rules.prefix`). No leading `+`
  // either (`drouting` rejects one in a prefix outright) — the dialplan
  // *condition* above still matches the original, unmodified
  // `destinationNumber`, only the bridge target is retagged/replumbed.
  const taggedNumber = drTag(drGroupId) + stripLeadingPlus(normalizedNumber);
  const target = `{${vars.join(',')}}sofia/internal/${taggedNumber}@${tenantDomain}`;

  // S2-05 (07 §6: "Per-tenant ... concurrent channel ... limits, enforced
  // in ... FS (`limit` with a Redis backend)"). No overflow
  // `[number [dialplan [context]]]` args: exceeding `max` hangs the calling
  // channel up on its own (mod_dptools' own documented default), which is
  // the desired behavior here — there is no "queue the call" fallback for
  // a toll-fraud control. Placed as its own action *before* `bridge`, not
  // folded into one data string: `limit` and `bridge` are independent
  // applications, chained the same way every other multi-action extension
  // in this codebase's own dialplan XML already is.
  const limitAction =
    maxConcurrentChannels === null
      ? ''
      : `          <action application="limit" data="${escapeXml(`redis ${tenantId} ${OUTBOUND_CHANNEL_LIMIT_RESOURCE} ${String(maxConcurrentChannels)}`)}"/>\n`;

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
    '<document type="freeswitch/xml">\n' +
    '  <section name="dialplan">\n' +
    `    <context name="${escapeXml(callerContext)}">\n` +
    `      <extension name="outbound-${escapeXml(destinationNumber)}">\n` +
    `        <condition field="destination_number" expression="${escapeXml(`^${escapeRegex(destinationNumber)}$`)}">\n` +
    `          ${tenantIdAction(tenantId)}\n` +
    `          ${outboundCallDirectionAction()}\n` +
    limitAction +
    `          <action application="bridge" data="${escapeXml(target)}"/>\n` +
    '        </condition>\n' +
    '      </extension>\n' +
    '    </context>\n' +
    '  </section>\n' +
    '</document>\n'
  );
}

/**
 * S2-08's own from-trunk branch: a DID resolving to a `ring_group`. Members
 * are handed over already in *ring order* (`fs.routes.ts`'s job: the plan
 * order for `sequential`, a Redis-rotated order for `round_robin`, a
 * shuffled order for `random`, or a plain list for `simultaneous` — this
 * builder itself stays a pure, deterministic string builder, the same
 * "no randomness inside `xml.ts`" discipline every other builder here
 * already keeps).
 *
 * `simultaneous` rings every member at once (`,`-joined bridge legs,
 * standard FreeSWITCH dial-string syntax — `switch_ivr_originate.c`'s own
 * comma-separated-leg behavior) under one `{call_timeout=N}` covering the
 * whole attempt. Every other strategy hunts members one at a time
 * (`|`-joined — "try the next leg if this one fails"), each with its own
 * `[leg_timeout=N]` prefix, so a no-answer on member 1 does not eat into
 * member 2's own ring time.
 *
 * The no-answer destination (`noAnswerBridgeNumber`, an extension's own
 * dialable number — `domain/ring-group.ts`'s "only `extension` resolves to a
 * real fallback today" scope) is a second `<action application="bridge">` in
 * the *same* `<condition>` block, right after the ring group's own bridge —
 * well-documented FreeSWITCH dialplan behavior (not this task's own
 * invention): a `bridge` action that fails to connect falls through to the
 * next action in the same extension, rather than hanging up on its own.
 *
 * None of this has been exercised against a real FreeSWITCH node yet in this
 * task (S2-08 defers SIPp-level proof to S2-20/#44 per the plan) — flagged
 * as G-38 in docs/decisions.md, the same "unverified live" honesty G-35/G-36
 * already gave S2-07's own FS-module assumptions.
 */
export function buildRingGroupDialplanDocument(
  callerContext: string,
  destinationNumber: string,
  tenantDomain: string,
  opensipsSipUri: string,
  tenantId: string,
  memberNumbersInRingOrder: readonly string[],
  strategy: 'simultaneous' | 'sequential' | 'round_robin' | 'random',
  ringTimeoutSeconds: number,
  noAnswerBridgeNumber: string | null,
): string {
  const routeVar = `sip_route_uri=sip:${opensipsSipUri}`;
  const legFor = (bridgeNumber: string): string => `sofia/internal/${bridgeNumber}@${tenantDomain}`;

  let bridgeTarget: string;
  if (strategy === 'simultaneous') {
    const legs = memberNumbersInRingOrder.map((number) => legFor(number)).join(',');
    bridgeTarget = `{${routeVar},call_timeout=${String(ringTimeoutSeconds)}}${legs}`;
  } else {
    const legs = memberNumbersInRingOrder
      .map((number) => `[leg_timeout=${String(ringTimeoutSeconds)}]${legFor(number)}`)
      .join('|');
    bridgeTarget = `{${routeVar}}${legs}`;
  }

  const noAnswerAction =
    noAnswerBridgeNumber === null
      ? ''
      : `          <action application="bridge" data="${escapeXml(`{${routeVar}}${legFor(noAnswerBridgeNumber)}`)}"/>\n`;

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
    '<document type="freeswitch/xml">\n' +
    '  <section name="dialplan">\n' +
    `    <context name="${escapeXml(callerContext)}">\n` +
    `      <extension name="ring-group-${escapeXml(destinationNumber)}">\n` +
    `        <condition field="destination_number" expression="${escapeXml(`^${escapeRegex(destinationNumber)}$`)}">\n` +
    `          ${tenantIdAction(tenantId)}\n` +
    `          <action application="bridge" data="${escapeXml(bridgeTarget)}"/>\n` +
    noAnswerAction +
    '        </condition>\n' +
    '      </extension>\n' +
    '    </context>\n' +
    '  </section>\n' +
    '</document>\n'
  );
}

/** A dispatchable civic address, formatted for the `X-Emergency-Location` header `buildEmergencyDialplanDocument` sets. */
export interface EmergencyLocationDetail {
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  readonly country: string;
}

/**
 * `/fs/dialplan`'s emergency branch (S2-06; G-1). Deliberately its own
 * function, not a variant of `buildOutboundDialplanDocument` above: an
 * emergency call skips E.164 normalization entirely (`destinationNumber`
 * dials exactly as-is — G-1's own "direct dial without a prefix"), never
 * carries a `limit` action (must reach the trunk "even when the tenant is
 * at its channel limit," S2-06's own "Done when"), and carries a location
 * header no ordinary outbound call has any reason to set.
 *
 * `X-Emergency-Location`: a single-line, human-readable civic address — the
 * generic default, not any particular carrier's own documented E911
 * format. G-1/issue #96 is explicit that "location delivery depends on
 * each carrier's E911 service," and no specific carrier's format (a PIDF-LO
 * body, a Geolocation header with a location-reference URI, …) is
 * implemented here — a documented gap (docs/decisions.md), not a silent
 * guess at one carrier's convention over another's.
 */
export function buildEmergencyDialplanDocument(
  callerContext: string,
  dialedNumber: string,
  tenantDomain: string,
  opensipsSipUri: string,
  tenantId: string,
  drGroupId: number,
  callerId: { readonly name: string | null; readonly number: string | null } | null,
  location: EmergencyLocationDetail | null,
): string {
  const vars: string[] = [`sip_route_uri=sip:${opensipsSipUri}`];
  if (callerId?.number !== null && callerId?.number !== undefined) {
    vars.push(`origination_caller_id_number=${callerId.number}`);
  }
  if (callerId?.name !== null && callerId?.name !== undefined) {
    vars.push(`origination_caller_id_name='${callerId.name}'`);
  }
  if (location !== null) {
    // `/` not `, `: the whole `{var=val,var=val}` prefix block is itself
    // comma-delimited (every var above shares it) — a literal `,` inside
    // this value would be read as the start of a new var, corrupting the
    // bridge string, the same class of mistake `[extraheader]`'s own blank-
    // line pitfall was in `uac_call.xml` (S1-14's own checkpoint memory).
    const addressLine = [
      location.addressLine1,
      location.addressLine2,
      location.city,
      location.state,
      location.postalCode,
      location.country,
    ]
      .filter((part): part is string => part !== null && part !== '')
      .join(' / ');
    vars.push(`sip_h_X-Emergency-Location='${addressLine}'`);
  }

  // Same tenant-isolation tag every OpenSIPs-routed outbound leg carries
  // (G-28) — `dialedNumber` itself is never normalized or stripped of a
  // leading `+` the way `buildOutboundDialplanDocument`'s destination is:
  // there is nothing to strip, G-1's own numbers are already bare digits.
  const taggedNumber = drTag(drGroupId) + dialedNumber;
  const target = `{${vars.join(',')}}sofia/internal/${taggedNumber}@${tenantDomain}`;

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
    '<document type="freeswitch/xml">\n' +
    '  <section name="dialplan">\n' +
    `    <context name="${escapeXml(callerContext)}">\n` +
    `      <extension name="emergency-${escapeXml(dialedNumber)}">\n` +
    `        <condition field="destination_number" expression="${escapeXml(`^${escapeRegex(dialedNumber)}$`)}">\n` +
    `          ${tenantIdAction(tenantId)}\n` +
    `          ${outboundCallDirectionAction()}\n` +
    `          <action application="bridge" data="${escapeXml(target)}"/>\n` +
    '        </condition>\n' +
    '      </extension>\n' +
    '    </context>\n' +
    '  </section>\n' +
    '</document>\n'
  );
}

/** One queue's own view of `callcenter.conf` — already filtered to its tenant's domain and its current tier list (`fs.routes.ts`'s `/fs/configuration` handler assembles this). */
export interface CallcenterQueueEntry {
  readonly name: string;
  readonly strategy: string;
  /** 0 = unlimited (`mod_callcenter`'s own `max-wait-time` convention, `domain/queue.ts` mirrors it). */
  readonly maxWaitSeconds: number;
  /** A credentialed `http_cache://` URL (`fs.routes.ts` builds it) for the queue's own uploaded MOH asset, or `null` for FS's built-in `local_stream://moh`. */
  readonly mohUrl: string | null;
  readonly tiers: readonly {
    readonly agentName: string;
    readonly level: number;
    readonly position: number;
  }[];
}

export interface CallcenterAgentEntry {
  readonly name: string;
  readonly maxNoAnswer: number;
  readonly wrapUpSeconds: number;
  readonly rejectDelaySeconds: number;
}

/**
 * `/fs/configuration`'s `callcenter.conf` response (S2-13; `mod_callcenter`).
 *
 * CONFIRMED LIVE (docs/decisions.md G-47, S2-20): the `<queues>`/`<agents>`/
 * `<tiers>` element shapes and the `strategy`/`moh-sound`/`max-wait-time`/
 * `contact`/`status`/`max-no-answer`/`wrap-up-time`/`reject-delay-time`/
 * `level`/`position` param names below are correct — `mod_callcenter` loads
 * them without error and reflects them back through `callcenter_config
 * agent list`/`tier list` exactly as sent, once `autoload_configs/
 * callcenter.conf.xml` exists at all (a real, separate bug this same
 * S2-20 pass found and fixed — see that file's own comment). Still
 * unconfirmed: whether `mod_http_cache`'s underlying client honours a
 * credentialed `moh-sound` URL the same way it does for `playback` (G-43's
 * own open question — this task's own queue never had an uploaded MOH
 * asset to exercise it, and separately, `mod_http_cache` itself was found
 * to have the identical missing-config load failure as `mod_callcenter`,
 * not fixed by this task). One thing is deliberately left out rather than
 * guessed at: `announce-position`/`announce-frequency-seconds` are stored
 * but never emitted here (whether `mod_callcenter` even has a literal
 * config-time param for position announcements, versus requiring
 * app-level scripting via `cc-queue-count`-style channel variables, is not
 * confirmed). Every agent's `status` starts `Logged Out` —
 * `buildAgentStatusDialplanDocument`'s own feature codes (fixed in this
 * same pass, see their own doc comment) are the only way to become
 * `Available`, confirmed live. What is NOT confirmed, and looks like a
 * genuine FreeSWITCH-internals issue rather than anything fixable here: an
 * `Available`/correctly-tiered agent is never actually offered a call by
 * `mod_callcenter`'s own dispatch mechanism — `tests/sip/test/
 * queue.test.ts`'s own top comment has the full detail.
 */
export function buildCallcenterConfigurationDocument(
  queues: readonly CallcenterQueueEntry[],
  agents: readonly CallcenterAgentEntry[],
): string {
  const queueXml = queues
    .map(
      (queue) =>
        `      <queue name="${escapeXml(queue.name)}">\n` +
        `        <param name="strategy" value="${escapeXml(queue.strategy)}"/>\n` +
        `        <param name="moh-sound" value="${escapeXml(queue.mohUrl ?? 'local_stream://moh')}"/>\n` +
        `        <param name="max-wait-time" value="${String(queue.maxWaitSeconds)}"/>\n` +
        '        <param name="tier-rules-apply" value="true"/>\n' +
        '      </queue>\n',
    )
    .join('');

  const agentXml = agents
    .map(
      (agent) =>
        `      <agent name="${escapeXml(agent.name)}" type="callback" contact="user/${escapeXml(agent.name)}" status="Logged Out" ` +
        `max-no-answer="${String(agent.maxNoAnswer)}" wrap-up-time="${String(agent.wrapUpSeconds)}" reject-delay-time="${String(agent.rejectDelaySeconds)}"/>\n`,
    )
    .join('');

  const tierXml = queues
    .flatMap((queue) =>
      queue.tiers.map(
        (tier) =>
          `      <tier agent="${escapeXml(tier.agentName)}" queue="${escapeXml(queue.name)}" level="${String(tier.level)}" position="${String(tier.position)}"/>\n`,
      ),
    )
    .join('');

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
    '<document type="freeswitch/xml">\n' +
    '  <section name="configuration">\n' +
    '    <configuration name="callcenter.conf" description="CallCenter">\n' +
    '      <queues>\n' +
    queueXml +
    '      </queues>\n' +
    '      <agents>\n' +
    agentXml +
    '      </agents>\n' +
    '      <tiers>\n' +
    tierXml +
    '      </tiers>\n' +
    '    </configuration>\n' +
    '  </section>\n' +
    '</document>\n'
  );
}

/**
 * `/fs/dialplan`'s from-trunk `queue` branch (S2-13; G-25's "each later
 * stage teaches `/fs/dialplan` to resolve its own destination type" — this
 * is that stage for `queue`). Reached only once the caller's handler has
 * already synchronously acquired the queue's affinity lease onto the
 * requesting node (`fs.routes.ts`'s `handleQueueDial`) — by the time this
 * document is returned, the node is guaranteed (well, "acquired" — 04 §3.3's
 * usual lease-lag caveat still applies) to have the queue loaded via its own
 * `/fs/configuration` re-fetch.
 */
export function buildQueueDialplanDocument(
  callerContext: string,
  destinationNumber: string,
  queueName: string,
  tenantId: string,
): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
    '<document type="freeswitch/xml">\n' +
    '  <section name="dialplan">\n' +
    `    <context name="${escapeXml(callerContext)}">\n` +
    `      <extension name="queue-${escapeXml(destinationNumber)}">\n` +
    `        <condition field="destination_number" expression="${escapeXml(`^${escapeRegex(destinationNumber)}$`)}">\n` +
    `          ${tenantIdAction(tenantId)}\n` +
    '          <action application="answer"/>\n' +
    `          <action application="callcenter" data="${escapeXml(queueName)}"/>\n` +
    '        </condition>\n' +
    '      </extension>\n' +
    '    </context>\n' +
    '  </section>\n' +
    '</document>\n'
  );
}

/**
 * The agent login/logout feature codes (S2-13; plan: "agent login and
 * logout feature codes"). `*45`/`*46` are this task's own arbitrary,
 * undocumented choice, the same "picked for familiarity, nothing more"
 * precedent `VOICEMAIL_RETRIEVAL_FEATURE_CODE` already sets (`fs.routes.ts`).
 *
 * Runs `callcenter_config agent set status` via `agent_status.lua` rather
 * than round-tripping to any backend service: an agent's live status is
 * `mod_callcenter`'s own in-memory state, not something this platform's
 * own DB tracks (`006_add_queues.ts`'s own comment, pbx-config-service, on
 * why `agents` has no `status` column) — so there is nothing to write back
 * here, only FS's own module to tell.
 *
 * CONFIRMED LIVE (S2-20, G-47): the original action here was
 * `<action application="api" data="callcenter_config ...">` — there is no
 * dialplan application named `api` in this image's module set at all
 * (confirmed directly: `mod_dptools`'s own `show application` listing has
 * no such entry), so every login/logout attempt failed outright
 * (`Invalid Application api`, channel hung up
 * `DESTINATION_OUT_OF_ORDER`) before ever reaching `mod_callcenter`. Fixed
 * by routing through a tiny Lua script instead — see its own doc comment
 * for why `status` travels as `0`/`1`, not the literal string.
 */
export const AGENT_LOGIN_FEATURE_CODE = '*45';
export const AGENT_LOGOUT_FEATURE_CODE = '*46';

export function buildAgentStatusDialplanDocument(
  callerContext: string,
  featureCode: string,
  agentName: string,
  status: 'Available' | 'Logged Out',
  tenantId: string,
): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
    '<document type="freeswitch/xml">\n' +
    '  <section name="dialplan">\n' +
    `    <context name="${escapeXml(callerContext)}">\n` +
    `      <extension name="agent-status-${escapeXml(featureCode)}">\n` +
    `        <condition field="destination_number" expression="${escapeXml(`^${escapeRegex(featureCode)}$`)}">\n` +
    `          ${tenantIdAction(tenantId)}\n` +
    '          <action application="answer"/>\n' +
    `          <action application="lua" data="agent_status.lua ${escapeXml(agentName)} ${status === 'Available' ? '1' : '0'}"/>\n` +
    '          <action application="hangup"/>\n' +
    '        </condition>\n' +
    '      </extension>\n' +
    '    </context>\n' +
    '  </section>\n' +
    '</document>\n'
  );
}

/**
 * `/fs/dialplan`'s park/retrieve branch (S2-14; `mod_valet_parking`). Both
 * parking (a transfer into an empty slot) and retrieval (dialing a slot
 * someone is already parked in) run the exact same action, since the
 * module's own state machine decides which one it is, not this document.
 *
 * `valet_park <lotname> <extension>` — confirmed live (S2-20, G-48): a
 * real FreeSWITCH process rejected the originally-shipped `lotname/ext`
 * (one slash-joined string) with `mod_valet_parking.c:757 Usage: <lotname>
 * <extension>|[ask ...]` — the module wants two space-separated arguments,
 * not one. Fixed here; G-48 still covers the longer `lotname/ext/timeout/
 * return-ext` return-on-timeout form, not attempted.
 */
export function buildParkDialplanDocument(
  callerContext: string,
  destinationNumber: string,
  lotName: string,
  slotNumber: number,
  tenantId: string,
): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
    '<document type="freeswitch/xml">\n' +
    '  <section name="dialplan">\n' +
    `    <context name="${escapeXml(callerContext)}">\n` +
    `      <extension name="park-${escapeXml(destinationNumber)}">\n` +
    `        <condition field="destination_number" expression="${escapeXml(`^${escapeRegex(destinationNumber)}$`)}">\n` +
    `          ${tenantIdAction(tenantId)}\n` +
    '          <action application="answer"/>\n' +
    // Confirmed live (S2-20, G-48): `valet_hold_music` falls back to the
    // channel's own hold-music setting when unset, and this platform sets
    // none — leaving it unset made `valet_park`'s own playback loop error
    // out and return within ~2s instead of holding, misreadable as "the
    // call parked, then immediately hung up." `silence` is the module's
    // own documented sentinel for a synthetic, always-resolvable stream
    // (no real audio file dependency, matching this platform's existing
    // caution about unconfirmed sound-file paths elsewhere, e.g. G-50).
    '          <action application="set" data="valet_hold_music=silence"/>\n' +
    `          <action application="valet_park" data="${escapeXml(`${lotName} ${String(slotNumber)}`)}"/>\n` +
    '        </condition>\n' +
    '      </extension>\n' +
    '    </context>\n' +
    '  </section>\n' +
    '</document>\n'
  );
}

/**
 * `/fs/dialplan`'s conference-room branch (S2-15; `mod_conference`). Hands
 * the call to `conference.lua` rather than an `action application="conference"`
 * directly (the same "PIN prompt needs DTMF collection first" reasoning
 * `voicemail.lua` already establishes for a mailbox PIN) — `roomName` is
 * `callcenterName`'s `id@domain` convention, reused here for the same
 * reason a queue/parking-lot name needs it: unique across tenants sharing
 * one FS node. `pinRequired` travels as an argv rather than a second HTTP
 * round-trip from the script, since `handleConferenceDial` already has it
 * from the local mirror.
 *
 * No `conference.conf` xml_curl binding is built to back `roomName`
 * (`docs/decisions.md` G-50) — a bare room name resolves against the
 * `default` profile defined statically in
 * `telephony/freeswitch/conf/autoload_configs/conference.conf.xml`, not a
 * per-room xml_curl lookup. Confirmed live in S2-20: `mod_conference`
 * requires that file to exist at all (a missing file, not just a missing
 * profile, fails the call), so "no binding" only works because that static
 * file is present — see the file's own comment.
 */
export function buildConferenceDialplanDocument(
  callerContext: string,
  destinationNumber: string,
  tenantId: string,
  roomId: string,
  roomName: string,
  pinRequired: boolean,
): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
    '<document type="freeswitch/xml">\n' +
    '  <section name="dialplan">\n' +
    `    <context name="${escapeXml(callerContext)}">\n` +
    `      <extension name="conference-${escapeXml(destinationNumber)}">\n` +
    `        <condition field="destination_number" expression="${escapeXml(`^${escapeRegex(destinationNumber)}$`)}">\n` +
    `          ${tenantIdAction(tenantId)}\n` +
    `          <action application="lua" data="conference.lua ${escapeXml(tenantId)} ${escapeXml(roomId)} ${escapeXml(roomName)} ${pinRequired ? '1' : '0'}"/>\n` +
    '        </condition>\n' +
    '      </extension>\n' +
    '    </context>\n' +
    '  </section>\n' +
    '</document>\n'
  );
}
