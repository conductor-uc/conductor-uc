import type { Database } from '@cuc/db';
import { secretEquals } from '@cuc/crypto';
import { Type, type Server } from '@cuc/http';
import type { Logger } from '@cuc/logger';
import type { Storage } from '@cuc/storage';
import type { Redis } from 'ioredis';

import { enqueueEvent } from '@cuc/events';

import { fromContextId } from '../context-id.js';
import { resolveOutboundCallerId, type CallerId } from '../domain/caller-id.js';
import { destinationCountry, normalizeToE164 } from '../domain/e164.js';
import { isOutboundCallAllowed, parseFraudLimits } from '../domain/fraud-limits.js';
import { telephonyEvents } from '../events.js';
import type { OrgClient } from '../org-client.js';
import type { PbxConfigClient } from '../pbx-config-client.js';
import type { OutboundRouteRow, ReadModelRepo } from '../repo/read-model.repo.js';
import { nextRoundRobinStart } from '../ring-group-counter.js';
import type { TelephonyConfigDb } from '../schema.js';
import type { VoicemailClient } from '../voicemail-client.js';
import {
  buildDialplanDocument,
  buildDirectoryDocument,
  buildEmergencyDialplanDocument,
  buildOutboundDialplanDocument,
  buildRingGroupDialplanDocument,
  buildVoicemailDialplanDocument,
  NOT_FOUND_DOCUMENT,
  type EmergencyLocationDetail,
} from '../xml.js';

/**
 * S2-16: dials the calling extension's own mailbox retrieval menu. An
 * arbitrary choice, not sourced from any spec (docs/decisions.md G-38) —
 * `*97` is a common convention in real-world PBXes, picked for familiarity,
 * nothing more.
 */
const VOICEMAIL_RETRIEVAL_FEATURE_CODE = '*97';

/** `/fs/media/:tenantId/:assetId/:rate` (S2-07) — `rate` names which transcoded variant, not a raw Hz value FS would need to parse. */
const MediaParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  assetId: Type.String({ minLength: 1 }),
  rate: Type.Union([Type.Literal('8k'), Type.Literal('16k')]),
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
const VoicemailCompleteMessageBodySchema = Type.Object({
  durationMs: Type.Number({ minimum: 0 }),
  sizeBytes: Type.Number({ minimum: 0 }),
});
const VoicemailPinBodySchema = Type.Object({ pin: Type.String({ minLength: 1 }) });

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
): void {
  // mod_xml_curl posts `application/x-www-form-urlencoded` (verified live
  // against a real FS node) — Fastify parses JSON and text/plain out of the
  // box but not this, so every field (including the dozens of `Caller-*`/
  // `Hunt-*`/`variable_*` ones a dialplan hunt attaches) needs an explicit
  // parser rather than a new dependency for one line of decoding.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  function authorized(authorization: string | undefined): boolean {
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
  async function handleOutboundDial(
    body: Record<string, string>,
    tenantId: string,
    destinationNumber: string,
    callerContext: string,
  ): Promise<string> {
    const country = await readModel.findTenantCountry(tenantId);
    if (country === undefined) {
      logger.info({ tenantId }, 'dialplan: tenant has no known country; cannot normalize outbound');
      return NOT_FOUND_DOCUMENT;
    }

    const normalized = normalizeToE164(destinationNumber, country);
    if (normalized === undefined) {
      logger.info({ tenantId, destinationNumber }, 'dialplan: could not normalize to E.164');
      return NOT_FOUND_DOCUMENT;
    }

    // S2-05 (07 §6: "International calling off by default. Country and
    // prefix allow-lists per tenant."). Fetched live, not cached
    // (`org-client.ts`'s own comment on why) — a genuine failure to reach
    // org-service fails this call closed too, the same as any other lookup
    // miss in this function, not a silent "assume unlimited."
    let rawLimits: Record<string, unknown> | undefined;
    try {
      rawLimits = await orgClient.findLimits(tenantId);
    } catch (error) {
      logger.warn(
        { tenantId, error: error instanceof Error ? error.message : String(error) },
        'dialplan: could not fetch fraud limits; failing the call closed',
      );
      return NOT_FOUND_DOCUMENT;
    }
    const limits = parseFraudLimits(rawLimits ?? {});
    const destCountry = destinationCountry(normalized);
    if (!isOutboundCallAllowed(limits, country, destCountry)) {
      logger.info(
        { tenantId, destCountry, tenantCountry: country },
        'dialplan: international call blocked by tenant policy',
      );
      return NOT_FOUND_DOCUMENT;
    }

    const routes = await readModel.findOutboundRoutesForTenant(tenantId);
    const route = findBestOutboundRoute(routes, normalized);
    if (route === undefined) {
      logger.info({ tenantId, normalized }, 'dialplan: no outbound route matches this number');
      return NOT_FOUND_DOCUMENT;
    }

    const domain = await readModel.findDomain(db.kysely, tenantId);
    if (domain === undefined) {
      logger.warn({ tenantId }, 'dialplan: tenant has no projected domain');
      return NOT_FOUND_DOCUMENT;
    }

    const callingNumber = body['variable_sip_from_user'];
    const callingExtension =
      callingNumber === undefined || callingNumber === ''
        ? undefined
        : await readModel.findExtensionByNumber(tenantId, callingNumber);

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

    const callerId = resolveOutboundCallerId(extensionCallerId, didCallerId, trunkCallerId);
    const drGroupId = await readModel.findOrCreateDrGroupId(db.kysely, tenantId);

    return buildOutboundDialplanDocument(
      callerContext,
      destinationNumber,
      normalized,
      domain.fqdn,
      opensipsSipUri,
      drGroupId,
      callerId,
      tenantId,
      limits.maxConcurrentChannels,
    );
  }

  app.post(
    '/fs/directory',
    // No `schema`: FS posts form-urlencoded, not JSON, and the response is
    // hand-built XML, not TypeBox-validated JSON — nothing here fits
    // Fastify's schema-driven request/response pipeline.
    { config: { public: true } },
    async (request, reply) => {
      if (!authorized(request.headers.authorization)) {
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

  app.post('/fs/dialplan', { config: { public: true } }, async (request, reply) => {
    if (!authorized(request.headers.authorization)) {
      reply.code(401);
      return '';
    }

    const body = request.body as Record<string, string>;
    reply.type('text/xml');
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

      const extension = await readModel.findExtensionByNumber(tenantId, destinationNumber);
      if (extension === undefined) {
        // Not a known extension — S2-04: this may still be a real call, just
        // an outbound one to the PSTN, not a rejection. `route{}`'s "request
        // from FS" branch already falls through to `do_routing()` on the
        // exact same signal (a `lookup("location")` miss on this same
        // R-URI) once this response bridges the call back to it.
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
      const mailbox = await voicemailClient.findMailboxByExtension(tenantId, extension.id);
      return buildDialplanDocument(
        callerContext,
        destinationNumber,
        domain.fqdn,
        opensipsSipUri,
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

      // `extension` (S2-03), `ring_group` (S2-08) and `voicemail` (S2-16,
      // returned above) resolve to a real call — every other destination
      // type still has no owning subsystem (docs/decisions.md G-25), so
      // this is an honest miss, not a guess at behavior only a later stage
      // can define.
      //
      // `ring_group` must stay in this list: the whole ring-group branch
      // below is unreachable without it, which is exactly what broke when
      // #133's merge dropped it — the branch survived, its guard did not,
      // so every ring-group DID silently 404'd.
      if (did.destinationType !== 'extension' && did.destinationType !== 'ring_group') {
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

        return buildDialplanDocument(
          callerContext,
          destinationNumber,
          domain.fqdn,
          opensipsSipUri,
          extension.number,
        );
      }

      // did.destinationType === 'ring_group' (S2-08).
      const ringGroup = await readModel.findRingGroupById(did.destinationId);
      if (ringGroup === undefined) {
        logger.warn(
          { didId: did.id, destinationId: did.destinationId },
          'dialplan: DID’s destination ring group no longer exists',
        );
        return NOT_FOUND_DOCUMENT;
      }

      const memberIds = parseMemberExtensionIds(ringGroup.memberExtensionIds);
      const members = (
        await Promise.all(memberIds.map((id) => readModel.findExtensionById(id)))
      ).filter((extension): extension is NonNullable<typeof extension> => extension !== undefined);
      if (members.length === 0) {
        logger.warn(
          { didId: did.id, ringGroupId: ringGroup.id },
          'dialplan: ring group has no resolvable members',
        );
        return NOT_FOUND_DOCUMENT;
      }

      let orderedMembers = members;
      if (ringGroup.strategy === 'round_robin') {
        const start =
          redis === null
            ? 0
            : await nextRoundRobinStart(redis, trunk.tenantId, ringGroup.id, members.length);
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
        orderedMembers.map((extension) => extension.number),
        ringGroup.strategy as 'simultaneous' | 'sequential' | 'round_robin' | 'random',
        ringGroup.ringTimeoutSeconds,
        noAnswerBridgeNumber,
      );
    }

    // Neither ext→ext (S1-13) nor from-trunk (S2-03) — honestly out of scope,
    // not silently guessed at.
    return NOT_FOUND_DOCUMENT;
  });

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
      if (!authorized(request.headers.authorization)) {
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

      const variantKey = rate === '8k' ? asset.variant8kKey : asset.variant16kKey;
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
   * `/fs/voicemail/...` (S2-16) — everything the Lua voicemail app
   * (`telephony/freeswitch/scripts/voicemail.lua`) reaches over `mod_curl`,
   * gated by the same shared `fs-node` token as every other `/fs/...` route.
   * Each handler is a thin proxy over `voicemailClient` into
   * voicemail-service's own internal API — this service never touches
   * voicemail-service's database (05 §1.1).
   */
  app.get(
    '/fs/voicemail/:tenantId/mailbox/by-extension/:extensionId',
    { config: { public: true }, schema: { params: VoicemailExtensionParamsSchema } },
    async (request, reply) => {
      if (!authorized(request.headers.authorization)) {
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
      if (!authorized(request.headers.authorization)) {
        reply.code(401);
        return '';
      }
      const { tenantId, mailboxId } = request.params;
      const valid = await voicemailClient.verifyPin(tenantId, mailboxId, request.body.pin);
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
      if (!authorized(request.headers.authorization)) {
        reply.code(401);
        return '';
      }
      const { tenantId, mailboxId } = request.params;
      const result = await voicemailClient.createMessage(tenantId, mailboxId, request.body);
      return reply.status(201).send(result);
    },
  );

  app.post(
    '/fs/voicemail/:tenantId/mailbox/:mailboxId/messages/:messageId/complete',
    {
      config: { public: true },
      schema: { params: VoicemailMessageParamsSchema, body: VoicemailCompleteMessageBodySchema },
    },
    async (request, reply) => {
      if (!authorized(request.headers.authorization)) {
        reply.code(401);
        return '';
      }
      const { tenantId, mailboxId, messageId } = request.params;
      return voicemailClient.completeMessage(tenantId, mailboxId, messageId, request.body);
    },
  );

  app.post(
    '/fs/voicemail/:tenantId/mailbox/:mailboxId/messages/:messageId/fail',
    { config: { public: true }, schema: { params: VoicemailMessageParamsSchema } },
    async (request, reply) => {
      if (!authorized(request.headers.authorization)) {
        reply.code(401);
        return '';
      }
      const { tenantId, mailboxId, messageId } = request.params;
      await voicemailClient.failMessage(tenantId, mailboxId, messageId);
      return reply.status(204).send();
    },
  );

  app.get(
    '/fs/voicemail/:tenantId/mailbox/:mailboxId/messages',
    { config: { public: true }, schema: { params: VoicemailMailboxParamsSchema } },
    async (request, reply) => {
      if (!authorized(request.headers.authorization)) {
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
      if (!authorized(request.headers.authorization)) {
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
      if (!authorized(request.headers.authorization)) {
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
      if (!authorized(request.headers.authorization)) {
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
      if (!authorized(request.headers.authorization)) {
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
      if (!authorized(request.headers.authorization)) {
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
      if (!authorized(request.headers.authorization)) {
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

  app.post('/fs/configuration', { config: { public: true } }, async (request, reply) => {
    if (!authorized(request.headers.authorization)) {
      reply.code(401);
      return '';
    }
    reply.type('text/xml');
    return NOT_FOUND_DOCUMENT;
  });
}
