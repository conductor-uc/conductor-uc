import type { Database } from '@cuc/db';
import type { Kysely } from 'kysely';

import type { OpenSipsDb } from '../opensips-schema.js';

/**
 * `registrant.expiry`, in seconds — also the module's own retry-after-
 * failure interval when `failure_retry_interval` is unset (the default,
 * per `README.uac_registrant.gz`). A standard SIP registration lifetime;
 * see `upsertRegistrant`'s own comment for why this can never be left
 * `NULL`.
 */
const REGISTRANT_EXPIRY_SECONDS = 3600;

/** A v4 UUID's hyphens stripped, to fit `address.context_info` (`CHAR(32)`). */
function toContextId(trunkId: string): string {
  return trunkId.replace(/-/g, '');
}

/** The inverse of {@link toContextId} — reassembles a standard 8-4-4-4-12 UUID. */
function fromContextId(contextId: string): string {
  return [
    contextId.slice(0, 8),
    contextId.slice(8, 12),
    contextId.slice(12, 16),
    contextId.slice(16, 20),
    contextId.slice(20),
  ].join('-');
}

/**
 * Writes to the `opensips` schema's `domain` and `subscriber` tables
 * (S1-12). Not `scoped(ctx)`: neither table has a `tenant_id` column — they
 * are OpenSIPs' own global tables, not a tenant-owned row shape — so this
 * goes through `Database.kysely` directly, the escape hatch `@cuc/db`
 * documents for exactly this case ("migrations, schema introspection, and
 * non-tenant tables"). 05 §1.1: telephony-config is the *only* writer to
 * this schema, so treating both tables as fully owned (an upsert here, an
 * unconditional delete there) is safe — nothing else ever writes a
 * conflicting row.
 */
export function createOpenSipsProjectionRepo(db: Database<OpenSipsDb>) {
  const k: Kysely<OpenSipsDb> = db.kysely;

  return {
    /**
     * `attrs` carries the owning tenant's id (S1-14) — the one piece of
     * per-domain data OpenSIPs' routing script actually needs back out.
     * `is_from_local($var(attrs))` (03 §2.1's "request from a registered
     * phone" branch) is the only way `route{}` can learn which tenant an
     * outbound call belongs to and set the trusted `X-Tenant-Id` header FS's
     * `/fs/dialplan` requires — OpenSIPs has no other reachable link back to
     * telephony-config's own read model.
     */
    async upsertDomain(fqdn: string, tenantId: string): Promise<void> {
      await k
        .insertInto('domain')
        .values({ domain: fqdn, attrs: tenantId, accept_subdomain: 0, last_modified: new Date() })
        .onDuplicateKeyUpdate({ attrs: tenantId, last_modified: new Date() })
        .execute();
    },

    async deleteDomain(fqdn: string): Promise<void> {
      await k.deleteFrom('domain').where('domain', '=', fqdn).execute();
    },

    /** Every domain currently projected — what reconciliation diffs against. */
    listDomains(): Promise<string[]> {
      return k
        .selectFrom('domain')
        .select('domain')
        .execute()
        .then((rows) => rows.map((r) => r.domain));
    },

    /**
     * `auth_db`'s `password_column` is `ha1` (`opensips.cfg.template`) —
     * `ha1_sha256`/`ha1_sha512t256` are left empty because nothing in this
     * deployment computes or checks them (MD5 digest only). `password` stays
     * empty too: this service never has the plaintext (05 §1.1 — only
     * pbx-config-service's `:reveal` ever decrypts it, S1-09).
     */
    async upsertSubscriber(username: string, domain: string, ha1: string): Promise<void> {
      await k
        .insertInto('subscriber')
        .values({
          username,
          domain,
          password: '',
          ha1,
          ha1_sha256: '',
          ha1_sha512t256: '',
        })
        .onDuplicateKeyUpdate({ ha1 })
        .execute();
    },

    async deleteSubscriber(username: string, domain: string): Promise<void> {
      await k
        .deleteFrom('subscriber')
        .where('username', '=', username)
        .where('domain', '=', domain)
        .execute();
    },

    /** Every (username, domain) currently projected. */
    listSubscribers(): Promise<{ username: string; domain: string }[]> {
      return k.selectFrom('subscriber').select(['username', 'domain']).execute();
    },

    /**
     * `uac_registrant`'s own credential + auth (S2-02): the module answers
     * the carrier's own digest challenges itself, so this is the one
     * `opensips` row this service ever writes a plaintext password into
     * (`opensips-schema.ts`'s own comment on `registrant`).
     *
     * `(aor, bindingUri, registrar)` is the vendored table's own unique
     * constraint (`registrant_idx`) — matches on it and only touches
     * `username`/`password`, since a *different* aor/registrar/bindingUri
     * means a different trunk identity entirely, not an update to this one
     * (the caller deletes the old row first when that changes —
     * `projection.ts`'s `projectTrunk`, the same "previous row" pattern
     * `upsertDomain`'s caller already uses for `domain`).
     *
     * `expiry` is a real value (`REGISTRANT_EXPIRY_SECONDS`), not `NULL`:
     * confirmed live against a real OpenSIPs 3.6.8 instance that
     * `README.uac_registrant.gz` means exactly what it says — "after any
     * kind of failure ... the registration is re-taken after `expires`
     * seconds" — a `NULL`/unset expiry resolves to some enormous internal
     * default (observed: a retry timestamp decades in the future), so a
     * single transient failure (a DNS hiccup, one dropped packet) would
     * otherwise leave the trunk stuck unregistered for the practical
     * lifetime of the process, never retried by the module's own timer.
     */
    async upsertRegistrant(registrant: {
      registrar: string;
      aor: string;
      username: string;
      password: string;
      bindingUri: string;
    }): Promise<void> {
      await k
        .insertInto('registrant')
        .values({
          registrar: registrant.registrar,
          proxy: null,
          aor: registrant.aor,
          third_party_registrant: null,
          username: registrant.username,
          password: registrant.password,
          binding_uri: registrant.bindingUri,
          binding_params: null,
          expiry: REGISTRANT_EXPIRY_SECONDS,
          forced_socket: null,
          cluster_shtag: null,
          state: 0,
        })
        .onDuplicateKeyUpdate({
          username: registrant.username,
          password: registrant.password,
          expiry: REGISTRANT_EXPIRY_SECONDS,
        })
        .execute();
    },

    async deleteRegistrant(aor: string, registrar: string, bindingUri: string): Promise<void> {
      await k
        .deleteFrom('registrant')
        .where('aor', '=', aor)
        .where('registrar', '=', registrar)
        .where('binding_uri', '=', bindingUri)
        .execute();
    },

    /** Every registrant row's natural key, for reconciliation. */
    listRegistrants(): Promise<{ aor: string; registrar: string; bindingUri: string }[]> {
      return k
        .selectFrom('registrant')
        .select(['aor', 'registrar', 'binding_uri as bindingUri'])
        .execute();
    },

    /**
     * `permissions`' address table (S2-02): inbound trunk identification by
     * source IP. `context_info` carries the owning trunk's id — the one
     * link `route{}`'s `check_source_address(1)` match can read back (03
     * §2's header-setting story) — so rows are managed per-trunk (delete
     * every row for a trunk, then insert its current IP set) rather than
     * upserted individually; the vendored table has no unique constraint to
     * upsert against in the first place.
     *
     * `context_info` is `CHAR(32)` in the vendored schema — too short for a
     * hyphenated UUID (36 chars) — so the trunk id is stored with its
     * hyphens stripped (`toContextId`/`fromContextId`, a lossless,
     * deterministic round trip for a standard v4 UUID) rather than
     * truncated, which would risk collisions between trunks.
     */
    async replaceAddresses(trunkId: string, cidrs: readonly { ip: string; mask: number }[]): Promise<void> {
      const contextId = toContextId(trunkId);
      await k.deleteFrom('address').where('context_info', '=', contextId).execute();
      if (cidrs.length === 0) return;
      await k
        .insertInto('address')
        .values(
          cidrs.map((cidr) => ({
            grp: 1,
            ip: cidr.ip,
            mask: cidr.mask,
            port: 0,
            proto: 'any',
            pattern: null,
            context_info: contextId,
          })),
        )
        .execute();
    },

    /** Every (trunkId, ip, mask) currently projected, for reconciliation. */
    listAddresses(): Promise<{ trunkId: string; ip: string; mask: number }[]> {
      return k
        .selectFrom('address')
        .select(['context_info as trunkId', 'ip', 'mask'])
        .where('context_info', 'is not', null)
        .execute()
        .then((rows) => rows.map((row) => ({ trunkId: fromContextId(row.trunkId!), ip: row.ip, mask: row.mask })));
    },

    /**
     * `drouting`'s gateway table (S2-02): one row per trunk, `gwid` keyed to
     * the trunk's own id (the vendored table's `dr_gw_idx` unique
     * constraint) — every trunk gets a gateway row regardless of auth mode,
     * since `dr_rules`/`do_routing()` (S2-04) will reference it by `gwid`
     * once outbound routes exist to route to it (docs/decisions.md G-23).
     */
    async upsertDrGateway(gateway: {
      gwid: string;
      address: string;
      description: string;
    }): Promise<void> {
      await k
        .insertInto('dr_gateways')
        .values({
          gwid: gateway.gwid,
          type: 0,
          address: gateway.address,
          strip: 0,
          pri_prefix: null,
          attrs: null,
          probe_mode: 0,
          state: 0,
          socket: null,
          description: gateway.description,
        })
        .onDuplicateKeyUpdate({ address: gateway.address, description: gateway.description })
        .execute();
    },

    async deleteDrGateway(gwid: string): Promise<void> {
      await k.deleteFrom('dr_gateways').where('gwid', '=', gwid).execute();
    },

    /** Every gateway's `gwid`, for reconciliation. */
    listDrGateways(): Promise<string[]> {
      return k
        .selectFrom('dr_gateways')
        .select('gwid')
        .execute()
        .then((rows) => rows.map((row) => row.gwid));
    },
  };
}

export type OpenSipsProjectionRepo = ReturnType<typeof createOpenSipsProjectionRepo>;
