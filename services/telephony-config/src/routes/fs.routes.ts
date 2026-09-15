import type { Database } from '@cuc/db';
import { secretEquals } from '@cuc/crypto';
import type { Server } from '@cuc/http';
import type { Logger } from '@cuc/logger';

import type { ReadModelRepo } from '../repo/read-model.repo.js';
import type { TelephonyConfigDb } from '../schema.js';
import { buildDialplanDocument, buildDirectoryDocument, NOT_FOUND_DOCUMENT } from '../xml.js';

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
    // the context name"): OpenSIPs sets both as custom SIP headers on the
    // leg toward FS, which FreeSWITCH auto-exposes as `sip_h_*` channel
    // variables — confirmed live, not assumed.
    const tenantId = body['variable_sip_h_X-Tenant-Id'];
    const callDirection = body['variable_sip_h_X-Call-Direction'];
    const destinationNumber = body['Caller-Destination-Number'];
    const callerContext = body['Caller-Context'];

    // Only ext→ext is in scope this task (S1-13's own line: "extension-to-
    // extension dialing within the tenant... calls to unknown numbers
    // rejected"). `from-trunk` DID routing is S2-03; anything else is
    // honestly out of scope, not silently guessed at.
    if (
      callDirection !== 'internal' ||
      tenantId === undefined ||
      tenantId === '' ||
      destinationNumber === undefined ||
      destinationNumber === '' ||
      callerContext === undefined ||
      callerContext === ''
    ) {
      return NOT_FOUND_DOCUMENT;
    }

    const extension = await readModel.findExtensionByNumber(tenantId, destinationNumber);
    if (extension === undefined) {
      logger.info(
        { tenantId, destinationNumber },
        'dialplan: no extension with that number in this tenant',
      );
      return NOT_FOUND_DOCUMENT;
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
