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
