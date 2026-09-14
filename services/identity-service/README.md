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
  org-service's `bootstrap-master` CLI calls. Gated by a shared bearer token (`INTERNAL_SERVICE_TOKEN`),
  matching the precedent 07 §1 sets for FS nodes and OpenSIPs, because real service-to-service auth
  (mTLS or a service JWT) does not exist yet.

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

There is no scheduled rotation job — nothing in this codebase runs cron jobs yet. `rotate()` is a
callable primitive, the same shape `@cuc/crypto`'s `rotate()` took in S0-09; wiring an actual
90-day schedule is separate infrastructure work.

## MFA tickets are not access tokens, on purpose

`tokens/ticket.ts`'s claim shape has no `org`, `ot`, `roles`, `perms`, or `sid` — nothing an access
token needs and a ticket should never be mistaken for having. `verifyAccessToken` checks for that
shape, not just a valid signature, specifically because an MFA ticket is signed by the *same* key
and would otherwise pass signature verification cleanly. A ticket also carries a `typ` that must
match what the endpoint expects, so an enrollment ticket cannot be replayed at the verification
endpoint or vice versa.

## What is deliberately not here yet

- **No general user CRUD, roles, grants, or API keys.** 06 lists these under identity-service's
  eventual public API; S1-05's stated scope is login/refresh/logout/MFA/JWKS plus the one internal
  endpoint. `identity.user.updated|disabled|deleted` and `identity.grant.changed` are not
  registered events for the same reason — nothing publishes them yet.
- **No password-reset flow.** `POST /v1/auth/password-reset` needs notification-service to send
  the email, and that does not exist until S3.
- **The TOTP issuer is the org's own id, not its display name.** `users` does not carry the org's
  name — only its id — so an authenticator app shows a UUID today rather than "Acme Resale". Never
  a fixed product name either way (02 §5.2); this is a placeholder for real data, not a brand
  workaround.
- **No org-ancestry authorization**, beyond "the caller already knows the right ids" — S1-06.
