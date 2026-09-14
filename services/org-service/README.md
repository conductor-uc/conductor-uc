# org-service

The org hierarchy: master → reseller → tenant (02 §1), generated from `pnpm gen:service`
(S0-08) and then substantially rewritten — `orgs` is not a tenant-owned table in the
`@cuc/db` sense (see `src/schema.ts`), so the generated widget-shaped sample entity did not
fit the actual domain model.

## What S1-03 adds

Domains (02 §3), on top of the `reseller_base_domains`/`tenant_domains` shells S1-01 left in
place.

- **A tenant's primary domain (`{slug}.{base}`) is assigned atomically inside `create()`**
  (`src/repo/org.repo.ts`), in the same transaction as the tenant row — unlike the
  cross-service admin-user call, nothing stops this one from being atomic, so a tenant is
  never left without a domain. `base` is the reseller's active base domain if it has one
  (earliest by `created_at`, when more than one), otherwise `PLATFORM_BASE_DOMAIN`.
- **Reseller base-domain registration and TXT verification** (`src/repo/domain.repo.ts`,
  `src/routes/domain.routes.ts`): `POST /v1/resellers/:id/base-domains` registers a
  `pending` candidate with a generated token; `POST .../base-domains/:domainId/verify` looks
  up a TXT record at `_domain-verification.{fqdn}` and activates the domain once it matches
  — `_domain-verification` is a deliberately generic label, never the codebase or product
  name, since a DNS record a reseller publishes is a network-visible surface (rule 1).
  `src/dns-resolver.ts` wraps `node:dns/promises` behind an interface so tests inject a fake
  resolver instead of needing control over real DNS.
- **Global uniqueness** (02 §3) is checked across *both* domain tables, in the same
  transaction as the insert — a candidate base domain can't collide with an existing tenant
  domain or another reseller's base domain, and vice versa.
- **`domain.manage`**, a new permission not in 07 §3.3 (added the same shape as every other
  `*.manage` entry — see `@cuc/authz`'s README), held by `reseller_admin` and `master_admin`.
  A tenant's own domain has no route to self-manage; it's assigned, not configured.
- Uses `/verify` as a plain path segment rather than 06's example `:verify` suffix, the same
  router-fragility finding S1-02 made for `:suspend`/`:resume`.

## What S1-02 adds

The provisioning API (06's org-service section): reseller and tenant create, read, update,
suspend, and resume, under `/v1/resellers` and `/v1/tenants` (`src/routes/org.routes.ts`).
Creating a reseller or a tenant also creates its first admin user, by calling
identity-service's internal endpoint (`src/identity-client.ts`) — the org row and the admin
user cannot be one transaction across two services' databases (05 §1.1), so a failure on the
admin-user side is reported back rather than silently swallowed or rolled back; there is no
delete capability yet to roll back with (see G-11 in `docs/decisions.md`).

H3 (only the master creates or manages a reseller) is enforced generically by `@cuc/http`'s
hard-rules hook, using only the caller's org type — see `h3RouteLevelLifecycle` in
`@cuc/authz`. Which specific role may create a *tenant* is not yet enforced per request:
that needs role resolution in the request context, which lands with api-gateway (S1-08).

`GET /v1/resellers/:id/tenants` only ever returns rows whose `parent_id` is the `:id` in the
URL — proven with a cross-reseller probe test — but nothing yet stops a caller from naming a
different reseller's id there. Same gap `example-service`'s template already calls out, for
the same reason.

## What S1-01 delivers

- The `orgs`, `reseller_base_domains`, `tenant_domains`, and `brands` tables (05 §3.1). The
  latter three are schema shells; their real columns and business logic land in S1-03 and
  S1-04 as compatible expansions (rule 7).
- The hierarchy invariants from 02 §1, enforced in two layers:
  - **Per-row, as real MariaDB CHECK constraints**: a master has no parent; `reseller_id` is
    set only on tenants.
  - **Cross-row, in the repository** (`src/repo/org.repo.ts`): a reseller's parent must be
    the master, a tenant's parent must be a reseller. This needs the parent's *actual* row,
    which only a read inside the same transaction as the insert can answer safely.
  - **The single-master constraint**, as a real constraint rather than only an application
    check: a generated virtual column that is `1` for a master row and `NULL` otherwise, with
    a unique index on it. MariaDB's unique index permits any number of `NULL`s, so this
    rejects a second master while imposing nothing on reseller and tenant rows.
- `pnpm --filter @cuc/org-service bootstrap-master --slug <slug> --name <name>`: creates the
  master org. Never through an API (02 §1) — this is the one place a master row is created.
  Idempotent: running it again logs "master org already exists" and exits 0, whichever of the
  two constraints above is what actually caught the repeat.

## What is deliberately not here yet

- **No admin user on the master.** The bootstrap CLI still only creates the org and logs that
  this step is outstanding — the master is never provisioned through an API (02 §1), so it
  never goes through `identity-client.ts` the way a reseller or tenant's admin user does.
- **No per-request `allowed()` authorization.** Routes declare `permission`/`dataClass`
  (rule 3) and H3 is enforced route-wide, but which role a caller actually holds is not
  resolved per request anywhere in this codebase yet — that needs the request context
  api-gateway builds (S1-08). Until then this matches every other service's routes.
- **No org delete.** `pending_deletion` → `deleted`, with a retention window and a data
  export, has no owning task yet — G-11 in `docs/decisions.md`.
- **No brand business logic** — verification, CRUD, uniqueness. S1-04.
- **No domain change or removal.** Once assigned, a tenant's primary domain is not
  reassigned if its reseller later activates a base domain, and neither domain table has a
  delete path — 02 §3 flags changing a tenant's domain as invalidating stored SIP digest
  HA1 values, a distinct, more involved operation this task does not build.
- **No ACME / TLS issuance.** 02 §3 mentions it; no task owns it yet.

## Verified

`pnpm build` / `typecheck` / `lint`: clean. `pnpm test`: 111 tests against real MariaDB
(including a live HTTP client test against a real `http.createServer` fake, proving
`identity-client.ts`'s wire behavior rather than mocking `fetch`), covering:

- The S1-01 hierarchy invariants: a tenant under master, a reseller under reseller, and a
  second master are all rejected.
- The S1-02 acceptance criterion: a master creates a reseller, a reseller creates a tenant,
  and a cross-reseller probe proves one reseller's tenant listing never includes another's.
- Update, suspend, resume, and their event publication; H3 denying a non-master actor at the
  HTTP layer; every `/v1/*` route declaring `permission` and `dataClass`.
- The S1-03 acceptance criterion: `org.domain.added` fires for both a tenant's assigned
  domain and a verified reseller base domain, and a full register → verify flow against an
  injected fake `DnsResolver` (matching, mismatching, missing, and throwing) passes.

The bootstrap CLI was run as a compiled process twice against a real schema: once creating
the master, once hitting `orgs_slug_idx` (same slug) and once hitting
`orgs_single_master_idx` (a different slug) — both mapped to the same idempotent, exit-0
outcome.
