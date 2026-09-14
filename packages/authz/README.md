# @cuc/authz

The access-control model from 07 §3: org ancestry, roles, grants, and the hard rules
H1–H4. No I/O, no dependency on any other `@cuc/*` package — a service feeds it plain
data (an `Actor`, a `ResourceRef`, the grants for that principal) and gets a `boolean`
back.

```ts
import { allowed, type Actor } from '@cuc/authz';

const actor: Actor = {
  id: user.id,
  type: 'user',
  org: { id: user.orgId, type: 'tenant', resellerId: 'reseller-1' },
  roleIds: await roles.roleIdsFor(user.id),
};

allowed({
  actor,
  permission: 'extension.manage',
  resource: { org: actor.org },
  grants: await grants.forPrincipal(actor.id, actor.roleIds),
});
```

## The formula (07 §3.1)

```
allowed(actor, permission, resource) =
  hardRules(actor, permission, resource) != DENY
  AND orgAncestry(actor.org, resource.org)
  AND (roleHas(actor, permission) OR grantMatches(actor, permission, resource))
```

`hardRulesPass` (`hard-rules.ts`) is checked first and unconditionally — no role or grant
overrides it:

- **H1** — a reseller can never touch `private`-class data belonging to a tenant.
  `h1PrivateDataWall` is the resource-aware form `allowed()` uses. `h1RouteLevelWall` is a
  coarser variant with no resource at all — just the actor's org type and the route's
  declared `dataClass` — for `@cuc/http`'s framework-level hook, which runs before a
  service has resolved what it's serving. It is deliberately stricter than the real rule
  (it denies a reseller reading its *own* `private`-classed config, which H1 proper
  allows), and that's the safe direction for an approximation to err in.
- **H2** — an actor cannot act outside its own org's ancestry, full stop.
- **H3** — `reseller.create` and `reseller.manage` are master-only, unconditionally, no
  matter whose resource is being touched.
- **H4** — API-key actors are restricted the same way regardless of role/grant.

`orgAncestry` (`ancestry.ts`) is master-sees-everything, reseller-sees-its-own-tenants,
tenant-sees-only-itself — nothing else.

`roleHas` and `grantMatches` (`evaluate.ts`) are the two ways a permission can be granted:
a role bundles a fixed permission set; a grant is one permission on one specific scope for
one principal (user or role), for the cases a role is too coarse for (an extension's own
voicemail, one queue's monitoring, etc.).

## The permission catalog and built-in roles

`PERMISSION_CATALOG` (`permissions.ts`) is transcribed from 07 §3.3: every permission and
the `DataClass` (`config` / `private` / `usage` / `secret`) it touches. `BUILT_IN_ROLES`
(`roles.ts`) is the seven fixed roles — `master_admin`, `master_support`,
`reseller_admin`, `reseller_support`, `tenant_admin`, `tenant_supervisor`, `tenant_user` —
as code, not rows, because nothing about them varies per deployment. `roleCatalog(custom)`
merges those built-ins with an org's custom roles (identity-service's `roles` table) into
the `RoleCatalog` `roleHas` reads.

**Known catalog gap:** `master_support`'s and `reseller_support`'s "read everything" /
"read config" descriptions in 07 §3.3 can't be fully realized — the catalog has no
read-counterpart permissions for most `*.manage` verbs (there's no `tenant.read` etc.).
This is flagged in `roles.ts` rather than papered over with invented permissions; closing
it is a `docs/decisions.md`-worthy change to 07 §3.3, not something to guess at here.

## The matrix test

`test/matrix.test.ts` is the acceptance-critical test: it generates every combination of
(org type × permission × actor/resource relationship) implied by the SAD §3 table,
independently derives the expected `allowed()`/denied outcome for each from the table's
text, and checks `allowed()` against it — 330+ generated cases. It assigns actors a
synthetic `HOLDS_EVERYTHING_ROLE_ID` role (bundling every known permission), not a real
built-in like `tenant_admin`, so the matrix tests ancestry and the hard rules in
isolation from which specific role bundles what permission. (`tenant_admin` not holding
`monitor.listen`/`whisper`/`barge` — that's `tenant_supervisor`'s — is a real, correctly
tested design choice, not something this matrix should trip over.) It also proves H1
cannot be overridden: neither an explicit grant nor a custom role lets a reseller reach a
tenant's private data, while the identical grant/role does work for the tenant's own
actor.

## Identity-service integration

Roles and grants are persisted by `identity-service` (`role.repo.ts`, `grant.repo.ts`),
not by this package — `@cuc/authz` only evaluates. `services/identity-service/test/role-grant.repo.test.ts`
is the other half of the acceptance criterion: it proves a role assigned or a grant
created through identity-service's real repositories (against real MariaDB) changes what
`allowed()` says, end to end.
