# identity-service

Users, credentials, sessions, and tokens (07 §1–2). Generated from `pnpm gen:service` (S0-08)
and then substantially rewritten — none of `users`, `sessions`, `mfa_factors`, or `signing_keys`
are tenant-owned tables in the `@cuc/db` sense (see `src/schema.ts`), so the generated
widget-shaped sample did not fit.

## What S1-05 delivers

- **Login** (`POST /v1/auth/login`): email + password, argon2id. A wrong password and an unknown
  email produce the identical error, so a login failure cannot be used to enumerate accounts.
- **MFA, required for master and reseller users** (07 §1), **not yet for tenants** — no per-tenant
  MFA setting exists yet; that is later config-surface work, called out where the check is made.
  - Not enrolled: login returns an **enrollment ticket** and TOTP material — never a token.
  - Enrolled: login returns a **verification ticket** — also never a token.
  - Either ticket, plus a correct 6-digit code, is what actually gets you tokens
    (`POST /v1/auth/mfa/enroll/confirm`, `POST /v1/auth/mfa/verify`).
- **Refresh rotation with reuse detection** (`POST /v1/auth/refresh`, 07 §2): each refresh returns
  a new token and invalidates the one just used. Presenting an already-used token revokes every
  session in its family — including ones issued by legitimate rotations since.
- **Logout** (`POST /v1/auth/logout`): revokes one session. Idempotent.
- **JWKS** (`GET /.well-known/jwks.json`): the public half of every signing key still valid for
  verification — the current one, plus any retired within the configured overlap window.
- **The internal admin-creation endpoint** (`POST /internal/v1/orgs/:orgId/admin-user`) — what
  org-service calls for a new reseller's or tenant's first admin, and its `bootstrap-master` CLI for
  the master's. Gated by a shared bearer token (`INTERNAL_SERVICE_TOKEN`),
  matching the precedent 07 §1 sets for FS nodes and OpenSIPs, because real service-to-service auth
  (mTLS or a service JWT) does not exist yet. With `firstUserOnly: true` it creates the user only
  while the org has nobody, and otherwise answers 409 `org_has_users` (G-115: re-running the
  bootstrap never adds a second administrator).

## Done when

> a refresh-token reuse test revokes the family, and a master user without MFA cannot obtain an
> access token beyond MFA enrollment

Both verified twice: as integration tests against real MariaDB (`test/auth-service.test.ts`), and
as a live HTTP smoke test against the compiled process — create a master admin, log in (get an
enrollment ticket, no tokens), confirm with a real, independently-computed TOTP code (get real
tokens), rotate, then replay the old refresh token and watch the whole family — including the
token from the *legitimate* rotation — go dead in one `401`.

## Why `users` doesn't fit `scoped(ctx)`, and what fills the gap

`users.org_id` can name a master, reseller, *or* tenant org, so `users` is not a
`TenantOwnedTable` (same reasoning as `orgs` in org-service — see that service's README). Every
repository here takes an explicit org id or user id and filters on it; reaching these functions at
all is the access control until `@cuc/authz` (S1-06) makes org ancestry mechanical.

`users.org_type` and `reseller_id` are **denormalized snapshots**, supplied by whoever creates the
user (today, only the internal endpoint), not read live from org-service. This avoids a
cross-schema join (05 §1.1) and an org-service read-model this task does not otherwise need — and
it cannot go stale, because orgs cannot be re-parented or change type in v1 (02 §1).

## Signing keys (07 §2)

EdDSA (Ed25519), generated on first startup if none exists (`ensureCurrentKey`, idempotent). The
private key is envelope-encrypted at rest via `@cuc/crypto`; it is only ever decrypted to sign.
`rotate()` retires the current key and generates a new one, in one transaction — a crash between
retiring and generating must not leave zero current keys. A retired key keeps verifying for
`SIGNING_KEY_OVERLAP_DAYS` (default 7; 07 §2 says "with overlap" but names no duration).

Rotation (G-116) is published ahead, in two phases, so api-gateway (which caches the JWKS for
`JWKS_CACHE_MAX_AGE_MS`) never meets a token signed with a key it has not fetched:

1. **Stage**: a *next* key is created with `activated_at` null. `forVerification` (the JWKS)
   includes it; `current()` does not, so nothing is signed with it.
2. **Promote**: once it has been published for `SIGNING_KEY_PUBLISH_AHEAD_MINUTES` (default 15,
   which must exceed the gateway's 10-minute cache), it gets `activated_at` and signs; the previous
   key is retired and stays published for `SIGNING_KEY_OVERLAP_DAYS`.

`src/signing-key-rotation.ts` calls `advance()` every 5 minutes and 30 s after startup: it promotes
a next key that is due, or stages one when the current key has signed for
`SIGNING_KEY_ROTATION_DAYS` (default 90; `0` = never stage, but still promote). Each step runs in one
transaction that first locks the current key's row by primary key (`SELECT … WHERE id = ? FOR UPDATE`, one row and no gaps, so waiting copies cannot deadlock with the holder's insert) and then reads the next
key with a second locking read, so any number of copies stage once and promote once between them,
and there is never more than one next key. `current()` reads which key is current on every token it
signs (only the decoded key is cached, by id), so every copy switches at promotion and none signs
with a staged key.

The operator command `rotate-signing-key` (`dist/src/cli/rotate-signing-key.js`) stages by default
and prints when the key will sign (the timer, or running the command again after that time,
promotes it). `--now` makes a fresh key current at once (a staged key is retired with the old one),
accepting a `JWKS_COOLDOWN_MS` window in which a gateway may refuse the new key. `--revoke-previous`
implies `--now` and also sets `revoked_at` on every earlier key, which removes it from the JWKS at
once instead of after the overlap.

## MFA tickets are not access tokens, on purpose

`tokens/ticket.ts`'s claim shape has no `org`, `ot`, `roles`, `perms`, or `sid` — nothing an access
token needs and a ticket should never be mistaken for having. `verifyAccessToken` checks for that
shape, not just a valid signature, specifically because an MFA ticket is signed by the *same* key
and would otherwise pass signature verification cleanly. A ticket also carries a `typ` that must
match what the endpoint expects, so an enrollment ticket cannot be replayed at the verification
endpoint or vice versa.

## What S1-07 adds

The `AUDIT` stream consumer and the audit trail's query API (05 §3.2, 07 §4) — see
`docs/decisions.md` (G-12, G-13) for what's deliberately incomplete about partition maintenance
and the query route's declared data class. `@cuc/audit`'s own README covers the publisher side
(`recordAuditEvent`/`publishAuditEvent`/`toUnscopedAccessSink`); this section is the consumer.

- **`consumers/audit.consumer.ts`**: one durable JetStream consumer (`identity-service-audit`)
  reading every `audit.event.recorded` envelope, from any service, and inserting it into
  `audit_events`. `main.ts` connects the NATS bus *before* creating the database handle
  specifically so `toUnscopedAccessSink(bus, logger)` is ready in time to back
  `createDatabase`'s `onUnscopedAccess` — the extension point `@cuc/db` built for exactly this
  in S0-03, previously defaulting to a `warn` log line.
- **`repo/audit.repo.ts`'s `listForOrg`** is the whole visibility rule (07 §4: "tenants can read
  their own audit trail… but not master-internal details") in one `WHERE actor_org_id = :orgId OR
  target_org_id = :orgId`: an org sees what its own actors did, plus what anyone did *to* its
  data. Nothing external to know an org's type or evaluate a data class at query time — a row
  naming neither field is structurally excluded, which is what keeps master's unrelated internal
  actions out of a tenant's view without a separate check.
- **`GET /v1/orgs/:orgId/audit-events`** — see G-13: declared `dataClass: 'config'` rather than
  the catalog's mixed `config/private`, so `reseller_admin`/`reseller_support` (which hold
  `audit.read`) aren't blocked outright by H1's coarse, route-level wall from reading their own
  org's trail.

## What is deliberately not here yet

- **No general user CRUD or API keys.** 06 lists these under identity-service's eventual public
  API; S1-05/S1-06/S1-07's combined scope is login/refresh/logout/MFA/JWKS, the internal
  admin-creation endpoint, roles/grants (S1-06), and the audit trail (S1-07).
  `identity.user.updated|disabled|deleted` is not a registered event for the same reason —
  nothing publishes it yet (`identity.grant.changed` is also still unpublished: `role.repo.ts`/
  `grant.repo.ts` don't emit domain events today, only the audit trail a caller wires up itself).
- **No password-reset flow.** `POST /v1/auth/password-reset` needs notification-service to send
  the email, and that does not exist until S3.
- **The TOTP issuer is the org's own id, not its display name.** `users` does not carry the org's
  name — only its id — so an authenticator app shows a UUID today rather than "Acme Resale". Never
  a fixed product name either way (02 §5.2); this is a placeholder for real data, not a brand
  workaround.
- **No per-request `allowed()` authorization.** `@cuc/authz` (S1-06) exists and its evaluator is
  fully tested, but no route here — or anywhere else in this codebase yet — resolves a caller's
  actual roles/grants per request and checks them; that needs the request context api-gateway
  builds (S1-08). Every route's declared `permission` is still just contract metadata today.
