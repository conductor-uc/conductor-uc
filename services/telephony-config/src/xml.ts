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
  /**
   * The user part actually dialed at the bridge target — S2-03's from-trunk
   * case needs this distinct from `destinationNumber` (matched against the
   * dialed digits, a DID's E.164) when the resolved destination is an
   * extension with a *different* dialable number. Defaults to
   * `destinationNumber` for the ext→ext case, where they are always the same.
   */
  bridgeNumber: string = destinationNumber,
): string {
  const target =
    `{sip_route_uri=sip:${opensipsSipUri}}` + `sofia/internal/${bridgeNumber}@${tenantDomain}`;

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
    '<document type="freeswitch/xml">\n' +
    '  <section name="dialplan">\n' +
    `    <context name="${escapeXml(callerContext)}">\n` +
    `      <extension name="ext-${escapeXml(destinationNumber)}">\n` +
    `        <condition field="destination_number" expression="${escapeXml(`^${escapeRegex(destinationNumber)}$`)}">\n` +
    `          <action application="bridge" data="${escapeXml(target)}"/>\n` +
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
  const vars: string[] = [`sip_route_uri=sip:${opensipsSipUri}`];
  if (callerId?.number !== null && callerId?.number !== undefined) {
    vars.push(`origination_caller_id_number=${callerId.number}`);
  }
  if (callerId?.name !== null && callerId?.name !== undefined) {
    vars.push(`origination_caller_id_name='${callerId.name}'`);
  }

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
    `          <action application="bridge" data="${escapeXml(target)}"/>\n` +
    '        </condition>\n' +
    '      </extension>\n' +
    '    </context>\n' +
    '  </section>\n' +
    '</document>\n'
  );
}
