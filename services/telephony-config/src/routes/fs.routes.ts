import type { Database } from '@cuc/db';
import { secretEquals } from '@cuc/crypto';
import type { Server } from '@cuc/http';
import type { Logger } from '@cuc/logger';

import { fromContextId } from '../context-id.js';
import { resolveOutboundCallerId, type CallerId } from '../domain/caller-id.js';
import { normalizeToE164 } from '../domain/e164.js';
import type { OutboundRouteRow, ReadModelRepo } from '../repo/read-model.repo.js';
import type { TelephonyConfigDb } from '../schema.js';
import {
  buildDialplanDocument,
  buildDirectoryDocument,
  buildOutboundDialplanDocument,
  NOT_FOUND_DOCUMENT,
} from '../xml.js';

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
export function registerFsRoutes(
  app: Server,
  db: Database<TelephonyConfigDb>,
  readModel: ReadModelRepo,
  fsXmlCurlToken: string,
  /** OpenSIPs' SIP listener, e.g. `opensips:5060` — see `xml.ts`'s `buildDialplanDocument`. */
  opensipsSipUri: string,
  logger: Logger,
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

      return buildDialplanDocument(callerContext, destinationNumber, domain.fqdn, opensipsSipUri);
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

      // Only `extension` resolves to a real call through S2-03 — every other
      // destination type has no owning subsystem yet (docs/decisions.md
      // G-25), so this is an honest miss, not a guess at behavior only a
      // later stage can define.
      if (did.destinationType !== 'extension') {
        logger.info(
          { didId: did.id, destinationType: did.destinationType },
          'dialplan: DID destination type has no owning subsystem yet',
        );
        return NOT_FOUND_DOCUMENT;
      }

      const extension = await readModel.findExtensionById(did.destinationId);
      if (extension === undefined) {
        logger.warn(
          { didId: did.id, destinationId: did.destinationId },
          'dialplan: DID’s destination extension no longer exists',
        );
        return NOT_FOUND_DOCUMENT;
      }

      const domain = await readModel.findDomain(db.kysely, trunk.tenantId);
      if (domain === undefined) {
        logger.warn({ tenantId: trunk.tenantId }, 'dialplan: tenant has no projected domain');
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

    // Neither ext→ext (S1-13) nor from-trunk (S2-03) — honestly out of scope,
    // not silently guessed at.
    return NOT_FOUND_DOCUMENT;
  });

  app.post('/fs/configuration', { config: { public: true } }, async (request, reply) => {
    if (!authorized(request.headers.authorization)) {
      reply.code(401);
      return '';
    }
    reply.type('text/xml');
    return NOT_FOUND_DOCUMENT;
  });
}
