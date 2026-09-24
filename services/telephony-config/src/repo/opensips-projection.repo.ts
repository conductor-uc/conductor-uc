import { createHash } from 'node:crypto';

import type { Database } from '@cuc/db';
import type { Kysely } from 'kysely';

import { fromContextId, toContextId } from '../context-id.js';
import type { OpenSipsDb } from '../opensips-schema.js';

/**
 * `(routeId, trunkId) -> gwid` (S2-04) — both are v4 UUIDs; `gwid` is
 * `CHAR(64)` in the vendored schema, too short for two hyphenated UUIDs
 * plus a separator (73 chars), so this strips hyphens from both (the same
 * `toContextId` trick `address.context_info` already uses) and
 * concatenates with no separator at all: 32 + 32 = exactly 64, and since
 * both halves are fixed-width, the join is unambiguous without one.
 */
export function outboundGwid(routeId: string, trunkId: string): string {
  return toContextId(routeId) + toContextId(trunkId);
}

/** The `routeId` half of an {@link outboundGwid} — what `deleteOutboundGatewaysForRoute`'s own `LIKE` prefix matches against. */
function outboundGwidRoutePrefix(routeId: string): string {
  return toContextId(routeId);
}

/**
 * How wide a {@link drTag} is, in digits (S2-04, docs/decisions.md G-28) —
 * zero-padded so every tenant's tag is exactly this many characters, the
 * same fixed-width-disambiguation trick {@link outboundGwid} already uses:
 * no tenant's tag can ever be a proper prefix of another's, so `dr_rules`'
 * prefix trie can only match the tag's own tenant. Six digits supports up
 * to 999,999 `tenant_dr_groups` rows — `dr_group_id` is `AUTO_INCREMENT`
 * and never reused, so this is a ceiling on lifetime tenant-count-ever, not
 * concurrent tenants.
 */
export const DR_TAG_WIDTH = 6;

/**
 * `do_routing()`'s own `groupID` parameter turned out to be compile-time
 * only — a runtime pvar there fails config parsing outright (confirmed
 * live, G-28). This tag is what replaces it: prepended to the dialed
 * number by FS's own outbound dialplan document
 * (`xml.ts`'s `buildOutboundDialplanDocument`) *before* the re-INVITE ever
 * reaches OpenSIPs, and to `dr_rules.prefix` for that same tenant's routes
 * (`projectOutboundRoute`) — `$rU` and the rule it must match always carry
 * the identical tag, so the prefix trie is the actual isolation mechanism,
 * not `do_routing()`'s group selection (called with that param omitted, a
 * single shared `default_group` modparam constant).
 */
export function drTag(groupId: number): string {
  return String(groupId).padStart(DR_TAG_WIDTH, '0');
}

/**
 * `dr_rules.groupid` (G-28) — every row uses this same literal, matching
 * `opensips.cfg.template`'s `modparam("drouting", "default_group", 0)`,
 * since `do_routing()` is always called with its own group param omitted
 * (a per-tenant value there was the design this constant replaces). Real
 * per-tenant isolation is {@link drTag}'s job, not this column's.
 */
export const DEFAULT_DR_GROUP_ID = 0;

/** Strips a leading `+` — `dr_rules.prefix` and the number FS bridges to must both be digit-only (G-29: `drouting` rejects `+` in a prefix outright). Every other layer (the domain model, `e164.ts`, the route pre-check in `fs.routes.ts`) keeps the `+`; only the two OpenSIPs-projection boundaries strip it. */
export function stripLeadingPlus(value: string): string {
  return value.startsWith('+') ? value.slice(1) : value;
}

/**
 * `registrant.expiry`, in seconds — also the module's own retry-after-
 * failure interval when `failure_retry_interval` is unset (the default,
 * per `README.uac_registrant.gz`). A standard SIP registration lifetime;
 * see `upsertRegistrant`'s own comment for why this can never be left
 * `NULL`.
 */
const REGISTRANT_EXPIRY_SECONDS = 3600;

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

    /**
     * A server-side TLS certificate for [domain]: a named row chosen by the SNI name
     * ([matchSipDomain]), or the `default` row (`matchIpAddress` `*`, no name) that
     * answers anything else. Type 2 is OpenSIPs' server domain.
     */
    async upsertTlsDomain(row: {
      domain: string;
      matchIpAddress: string | null;
      matchSipDomain: string | null;
      certificate: string;
      privateKey: string;
    }): Promise<void> {
      const values = {
        match_ip_address: row.matchIpAddress,
        match_sip_domain: row.matchSipDomain,
        method: 'SSLv23',
        verify_cert: 0,
        require_cert: 0,
        certificate: row.certificate,
        private_key: row.privateKey,
        cipher_list: 'HIGH:!aNULL:!MD5:!RC4:!3DES',
      };
      await k
        .insertInto('tls_mgm')
        .values({ domain: row.domain, type: 2, ...values })
        .onDuplicateKeyUpdate(values)
        .execute();
    },

    async deleteTlsDomain(domain: string): Promise<void> {
      await k.deleteFrom('tls_mgm').where('domain', '=', domain).where('type', '=', 2).execute();
    },

    /** Every TLS server row with the SHA-256 of its certificate, for reconciliation to compare. */
    async listTlsDomains(): Promise<{ domain: string; fingerprint: string }[]> {
      const rows = await k
        .selectFrom('tls_mgm')
        .select(['domain', 'certificate'])
        .where('type', '=', 2)
        .execute();
      return rows.map((r) => ({
        domain: r.domain,
        // A BLOB comes back as a Buffer from the driver, text from a test double.
        fingerprint: createHash('sha256')
          .update(
            Buffer.isBuffer(r.certificate)
              ? r.certificate.toString('utf8')
              : String(r.certificate ?? ''),
            'utf8',
          )
          .digest('hex'),
      }));
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
    async replaceAddresses(
      trunkId: string,
      cidrs: readonly { ip: string; mask: number }[],
    ): Promise<void> {
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
        .then((rows) =>
          rows.map((row) => ({ trunkId: fromContextId(row.trunkId!), ip: row.ip, mask: row.mask })),
        );
    },

    /**
     * `drouting`'s gateway table (S2-02): one row per trunk, `gwid` keyed to
     * the trunk's own id (the vendored table's `dr_gw_idx` unique
     * constraint) — every trunk gets a gateway row regardless of auth mode,
     * since `dr_rules`/`do_routing()` (S2-04) will reference it by `gwid`
     * once outbound routes exist to route to it (docs/decisions.md G-23).
     */
    /**
     * `attrs` carries `username:password:realm` for a trunk with a register
     * credential (S2-04) — `route{}`'s outbound branch reads it back via
     * `do_routing()`'s `gw_attrs_pvar` and sets it as `uac_auth`'s AVPs
     * before relaying, so an outbound INVITE to that gateway can answer a
     * 401/407 challenge. `null` for an ip-mode trunk with nothing to
     * authenticate with — `uac_auth()` simply never gets called for it (no
     * challenge ever arrives for a carrier that trusts by source IP).
     * Assumes the trunk's own `host` doubles as the realm its challenges
     * use — the same convention `registrant`'s own AOR domain already
     * relies on; a carrier whose challenge realm differs needs a real fix,
     * flagged if it ever surfaces (docs/decisions.md).
     */
    async upsertDrGateway(gateway: {
      gwid: string;
      address: string;
      description: string;
      attrs?: string | null;
    }): Promise<void> {
      const attrs = gateway.attrs ?? null;
      await k
        .insertInto('dr_gateways')
        .values({
          gwid: gateway.gwid,
          type: 0,
          address: gateway.address,
          strip: 0,
          pri_prefix: null,
          attrs,
          probe_mode: 0,
          state: 0,
          socket: null,
          description: gateway.description,
        })
        .onDuplicateKeyUpdate({ address: gateway.address, description: gateway.description, attrs })
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

    /**
     * `drouting`'s rule table (S2-04) — one row per outbound route, keyed
     * on the route's own id via `description` (the vendored schema has no
     * dedicated "external id" column; `routeid`/`ruleid` are drouting's own
     * concepts, not ours). `gwlist` is the route's `trunkIds`, comma-joined
     * in try-order — `sort_alg` stays the table's own `'N'` default so
     * `do_routing()`/`use_next_gw()` walk it in exactly that order (03 §2.1's
     * failover sequence).
     */
    /**
     * A per-route gateway (S2-04): `dr_gateways.strip`/`pri_prefix` are the
     * module's own built-in, gateway-level number-rewriting fields —
     * `do_routing()`/`use_next_gw()` apply them automatically to `$rU` as
     * part of selecting that gateway, no manual script string manipulation
     * needed. Since a single trunk can be referenced by more than one
     * outbound route, each potentially wanting a *different* strip/prepend
     * (05 §3.4 puts those fields on `outbound_routes`, not `trunks`), this
     * is a synthesized row keyed on `(routeId, trunkId)`, not the trunk's
     * own bare `gwid` — S2-02's own per-trunk `dr_gateways` row (used for
     * inbound LCR gateway existence, independent of any route) is left
     * alone, a separate row entirely.
     */
    async upsertOutboundGateway(gateway: {
      routeId: string;
      trunkId: string;
      address: string;
      description: string;
      strip: number;
      prepend: string | null;
      attrs?: string | null;
    }): Promise<void> {
      const attrs = gateway.attrs ?? null;
      await k
        .insertInto('dr_gateways')
        .values({
          gwid: outboundGwid(gateway.routeId, gateway.trunkId),
          type: 0,
          address: gateway.address,
          strip: gateway.strip,
          pri_prefix: gateway.prepend,
          attrs,
          probe_mode: 0,
          state: 0,
          socket: null,
          description: gateway.description,
        })
        .onDuplicateKeyUpdate({
          address: gateway.address,
          strip: gateway.strip,
          pri_prefix: gateway.prepend,
          attrs,
          description: gateway.description,
        })
        .execute();
    },

    /** Every synthesized gateway this route fed, removed together with the route's own `dr_rules` row. */
    async deleteOutboundGatewaysForRoute(routeId: string): Promise<void> {
      await k
        .deleteFrom('dr_gateways')
        .where('gwid', 'like', `${outboundGwidRoutePrefix(routeId)}%`)
        .execute();
    },

    /**
     * `drouting`'s rule table (S2-04) — one row per outbound route, keyed
     * on the route's own id via `description` (the vendored schema has no
     * dedicated "external id" column; `routeid`/`ruleid` are drouting's own
     * concepts, not ours). `gwlist` is the route's own synthesized gateway
     * ids (`upsertOutboundGateway`'s `outboundGwid`), comma-joined in
     * try-order — `sort_alg` stays the table's own `'N'` default so
     * `do_routing()`/`use_next_gw()` walk it in exactly that order (03 §2.1's
     * failover sequence). `prefix` is expected to already carry the calling
     * tenant's own {@link drTag} (`projectOutboundRoute`'s job) — `groupid`
     * itself is always {@link DEFAULT_DR_GROUP_ID}, not a per-tenant value
     * (G-28).
     */
    async upsertDrRule(rule: {
      routeId: string;
      prefix: string;
      priority: number;
      gwlist: readonly string[];
    }): Promise<void> {
      const gwlist = rule.gwlist.join(',');
      const existing = await k
        .selectFrom('dr_rules')
        .select('ruleid')
        .where('description', '=', rule.routeId)
        .executeTakeFirst();

      if (existing === undefined) {
        await k
          .insertInto('dr_rules')
          .values({
            groupid: String(DEFAULT_DR_GROUP_ID),
            prefix: rule.prefix,
            timerec: null,
            priority: rule.priority,
            routeid: null,
            gwlist,
            sort_alg: 'N',
            sort_profile: null,
            attrs: null,
            description: rule.routeId,
          })
          .execute();
      } else {
        await k
          .updateTable('dr_rules')
          .set({
            groupid: String(DEFAULT_DR_GROUP_ID),
            prefix: rule.prefix,
            priority: rule.priority,
            gwlist,
          })
          .where('ruleid', '=', existing.ruleid)
          .execute();
      }
    },

    async deleteDrRule(routeId: string): Promise<void> {
      await k.deleteFrom('dr_rules').where('description', '=', routeId).execute();
    },

    /**
     * S2-06: an emergency route can carry more than one number
     * (`emergency_routes.numbers`), but `dr_rules.prefix` only ever matches
     * one prefix per row — `projectEmergencyRoute` writes one rule per
     * number, keyed `${emergencyRouteId}:${number}` (`description`, this
     * service's own synthetic key, not read by `drouting` itself), so
     * cleanup needs the same `LIKE` prefix-match idiom
     * `deleteOutboundGatewaysForRoute` already uses for its own gateways.
     */
    async deleteDrRulesByDescriptionPrefix(prefix: string): Promise<void> {
      await k.deleteFrom('dr_rules').where('description', 'like', `${prefix}:%`).execute();
    },

    /** Every rule's own route id (`description`), for reconciliation. */
    listDrRules(): Promise<string[]> {
      return k
        .selectFrom('dr_rules')
        .select('description')
        .execute()
        .then((rows) =>
          rows.map((row) => row.description).filter((id): id is string => id !== null),
        );
    },
  };
}

export type OpenSipsProjectionRepo = ReturnType<typeof createOpenSipsProjectionRepo>;
