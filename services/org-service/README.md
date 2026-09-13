# org-service

The org hierarchy: master → reseller → tenant (02 §1), generated from `pnpm gen:service`
(S0-08) and then substantially rewritten — `orgs` is not a tenant-owned table in the
`@cuc/db` sense (see `src/schema.ts`), so the generated widget-shaped sample entity did not
fit the actual domain model.

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

- **No HTTP routes.** The provisioning API — reseller and tenant CRUD, suspend, resume — is
  S1-02's job. This service currently serves only `/healthz` and `/readyz` (06).
- **No admin user on the master.** "That admin user is created through identity-service's
  internal API, which is stubbed until S1-05" (the S1-01 task text, verbatim). The bootstrap
  CLI creates the org and logs a warning that this step is outstanding, rather than inventing
  a fake identity integration that S1-05 would have to unwind.
- **No org-ancestry authorization.** `@cuc/authz` lands in S1-06. Until then, the repository's
  own comments call out that calling it at all is the access control — nothing routes to it
  except the bootstrap CLI, and the reseller-scoped-by-`reseller_id` filtering it does (05 §2.5)
  is a placeholder for what the authz layer will take over.
- **No domain or brand business logic** — verification, CRUD, uniqueness beyond the schema
  itself. S1-03 and S1-04.

## Verified

`pnpm build` / `typecheck` / `lint`: clean. `pnpm test`: 30 tests against real MariaDB,
including the acceptance criterion — a tenant under master, a reseller under reseller, and a
second master are all rejected. The bootstrap CLI was run as a compiled process twice against
a real schema: once creating the master, once hitting `orgs_slug_idx` (same slug) and once
hitting `orgs_single_master_idx` (a different slug) — both mapped to the same idempotent,
exit-0 outcome.
