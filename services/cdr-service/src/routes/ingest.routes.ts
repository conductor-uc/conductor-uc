import { secretEquals } from '@cuc/crypto';
import type { Server } from '@cuc/http';

import { InvalidCdrPayloadError, normalizeCdr } from '../domain/cdr.js';
import { CdrAlreadyIngestedError, type CdrRepo } from '../repo/cdr.repo.js';
import type { TenantResellerLookup } from '../org-client.js';

/**
 * `POST /ingest/json-cdr` (S2-18; 06's cdr-service section) — what
 * `mod_json_cdr` POSTs to at hangup (`telephony/freeswitch/conf/
 * autoload_configs/mod_json_cdr.conf.xml`'s own `cred` param). Gated by
 * HTTP Basic auth against a shared per-environment token, the same
 * `fs-node:<token>` convention `xml_curl.conf.xml`'s own bindings already
 * use (07 §1's "shared per-environment token on the xml_curl, CDR ingest,
 * and IR endpoints").
 *
 * Always answers `200` once the body parses as JSON, whatever happens next
 * — `mod_json_cdr` retries on a non-2xx response (07 §1), and retrying a
 * *malformed* payload would just fail identically forever, so a bad payload
 * is logged and swallowed rather than causing an endless retry loop FS's
 * own side cannot recover from. A dedupe hit (`CdrAlreadyIngestedError`) is
 * exactly the "already got this one" case that retry exists for, so it is
 * also a `200`, not an error.
 */
export function registerIngestRoutes(
  app: Server,
  cdrRepo: CdrRepo,
  resellerForTenant: TenantResellerLookup,
  ingestToken: string,
): void {
  function authorized(authorization: string | undefined): boolean {
    if (authorization === undefined) return false;
    const [scheme, encoded] = authorization.split(' ');
    if (scheme !== 'Basic' || encoded === undefined || encoded === '') return false;
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator === -1) return false;
    return secretEquals(ingestToken, decoded.slice(separator + 1));
  }

  app.post('/ingest/json-cdr', { config: { public: true } }, async (request, reply) => {
    if (!authorized(request.headers.authorization)) {
      reply.code(401);
      return '';
    }

    let normalized;
    try {
      normalized = normalizeCdr(request.body);
    } catch (error) {
      if (!(error instanceof InvalidCdrPayloadError)) throw error;
      request.log.warn({ err: error }, 'rejected a malformed mod_json_cdr payload');
      reply.code(200);
      return '';
    }

    let resellerId: string | null;
    try {
      resellerId = (await resellerForTenant(normalized.tenantId)) ?? null;
    } catch (error) {
      request.log.warn(
        { err: error, tenantId: normalized.tenantId },
        'could not resolve the owning reseller; ingesting with reseller_id null',
      );
      resellerId = null;
    }

    try {
      await cdrRepo.ingest(normalized, resellerId);
    } catch (error) {
      if (!(error instanceof CdrAlreadyIngestedError)) throw error;
      request.log.info({ callUuid: normalized.callUuid }, 'duplicate CDR ingest; ignoring');
    }

    reply.code(200);
    return '';
  });
}
