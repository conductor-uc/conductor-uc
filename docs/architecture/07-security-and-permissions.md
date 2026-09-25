# 07 — Security & permissions

## 1. Principals

| Principal | Authenticates with | Belongs to |
|---|---|---|
| Console user | Email + password (argon2id) + MFA (TOTP; WebAuthn later) | Exactly one org (master, reseller, or tenant) |
| API key | `Authorization: Bearer cuc_<prefix>_<secret>` (hash stored) | One org, with an explicit permission list |
| Service | mTLS or a service JWT (client-credentials from identity-service) | Platform |
| FS node / OpenSIPs | Network ACL + shared per-environment token on the xml_curl, CDR ingest, and IR endpoints | Platform |
| SIP endpoint | SIP digest against the tenant realm (OpenSIPs) | Tenant |
| XMPP client | Via chat-service / identity-service | Tenant |

MFA is **required** for master and reseller users. For tenant users it is configurable per tenant.

## 2. Tokens

- The access token is a JWT signed with EdDSA, lives 10 minutes, and has these claims: `sub`, `org` (org ID), `ot` (org type), `rsl` (reseller ID, if any), `roles` (role IDs), `perms` (a compact set of coarse permissions), `amr` (auth methods), and `sid` (session).
- The refresh token is opaque and lives 30 days (sliding), with rotation and reuse detection. On reuse, the whole family is revoked.
- The console stores the access token in memory and the refresh token in an `HttpOnly; Secure; SameSite=Strict` cookie scoped to the console hostname.
- Keys are published via JWKS and rotated every 90 days with overlap.

## 3. Authorization

### 3.1 Model

Authorization combines **roles** (bundles of permissions) and **grants** (a permission on a specific scope), plus **hard rules** that no grant can override.

```
allowed(actor, permission, resource) =
    hardRules(actor, permission, resource) != DENY
    AND ( orgAncestry(actor.org, resource.org)
          AND (roleHas(actor, permission) OR grantMatches(actor, permission, resource)) )
```

- **Org ancestry:** an actor may act on its own org or on descendants. Master is an ancestor of everything, and a reseller is an ancestor of its own tenants only.
- **Scopes:** `org:{id}`, `extension:{id}`, `extension_group:{id}`, `queue:{id}`, `mailbox:{id}`, `did:{id}`. A grant with scope `org` covers everything in that org.
- **Hard rules** (checked first; code, not data):
  1. **H1 (reseller private-data wall):** an actor whose org is a reseller is DENIED any permission whose data class is `private` on a tenant resource, whatever roles or grants exist.
  2. **H2:** tenant actors cannot access resources outside their tenant.
  3. **H3:** only master actors can create or modify resellers, or read the reseller records (`reseller.read`, G-10).
  4. **H4:** API keys cannot manage users, roles, grants, or other API keys.
- Every master access to a `private` data class resource is allowed (SAD §10) but is **audited with `data_class=private`**. The console asks for a free-text reason, which is stored in the audit event. Whether a reason is mandatory is configurable.

### 3.2 Data classes

| Class | Examples | Reseller access |
|---|---|---|
| `config` | Tenant settings, extensions, DIDs, trunks, flows, queues (definitions), users (not credentials) | Yes (own tenants) |
| `private` | CDRs, recordings, voicemail, chat messages, SMS/fax content, live call monitoring, per-call analytics, the audit trail of tenant private access | **No** (H1) |
| `usage` | Aggregate counts and minutes per tenant | Yes, always on (D-013, issue #95) — a `billing.read`-gated view distinct from the full, tenant-private CDR |
| `secret` | SIP passwords, trunk credentials, API key secrets | Write-only; reveal requires a specific permission and is audited |

Every route declares its data class in its route schema (`config.dataClass`), and `@cuc/http` enforces H1 automatically. A CI test asserts that every route declares one.

### 3.3 Permission catalog (initial)

| Permission | Class | Default holders |
|---|---|---|
| `reseller.create` / `reseller.manage` | config | Master admin |
| `reseller.read` | config | Master admin, master support (H3: master only) |
| `tenant.create` / `tenant.manage` / `tenant.suspend` | config | Reseller admin, master admin |
| `domain.manage`, `brand.manage` | config | Reseller admin |
| `user.manage` / `role.manage` / `grant.manage` | config | Org admins |
| `extension.manage`, `did.manage`, `group.manage`, `queue.manage`, `parking_lot.manage`, `conference_room.manage`, `schedule.manage`, `media.manage` | config | Tenant admin, reseller admin |
| `trunk.manage` | config | Reseller admin, tenant admin (opt-in) |
| `emergency_location.manage`, `emergency_route.manage` | config | Tenant admin, reseller admin — G-1: the reseller carries the compliance obligation, but a tenant admin provisions its own extensions' locations day to day |
| `callflow.edit` / `callflow.publish` | config | Tenant admin |
| `secret.reveal` | secret | Tenant admin (audited) |
| `recording.policy.manage` | config | Tenant admin |
| `tenant.read`, `domain.read`, `brand.read`, `user.read`, `role.read`, `grant.read`, `extension.read`, `did.read`, `emergency_location.read`, `emergency_route.read`, `group.read`, `queue.read`, `parking_lot.read`, `conference_room.read`, `schedule.read`, `media.read`, `trunk.read` | config | Master support, reseller support; implied by the matching `.manage` (G-10). Tenant supervisor: `queue.read`, `extension.read` |
| `callflow.read`, `recording.policy.read` | config | Master support; implied by `callflow.edit`/`callflow.publish` and `recording.policy.manage` (G-10) |
| `recording.listen` / `recording.download` / `recording.delete` | private | Tenant admin; grantable per `extension`/`queue` scope |
| `cdr.read` / `cdr.export` | private | Tenant admin |
| `voicemail.access` | private | Mailbox owner; grantable per `mailbox` |
| `monitor.presence` | config | Tenant users (tenant-wide) |
| `monitor.listen` / `monitor.whisper` / `monitor.barge` | private | Tenant supervisors, **scoped to target extensions or queues** |
| `analytics.view` | private | Tenant admin / supervisor |
| `audit.read` | config/private | Org admins (private entries are visible only to the tenant and the master) |
| `apikey.manage` | secret | Org admins |

**Read twins (G-10).** Every configuration management permission has a `.read` twin of the same class. List and view routes declare the twin and writes keep the management permission. Holding a management permission implies its twin wherever permissions are evaluated (`READ_TWINS` in `@cuc/authz`: `roleHas`, `grantMatches`, identity-service's permission lookup and `/me`, the `@cuc/http` permission guard, and the console), so admins and custom roles that name only `.manage` keep reading without being re-granted. Nothing else implies anything, and no permission implies a `private` one. The secret-class permissions (`secret.reveal`, `apikey.manage`) have no twin. The console shows a screen read-only to a person who holds its `.read` permission without its `.manage` permission.

Monitoring is a "who can do this to whom" check. A grant `monitor.barge` scoped to `queue:Q1` lets its holder barge calls where the target channel is an agent of Q1 **or** the call is in Q1. `call-control` evaluates this against the live call record in Redis.

Built-in roles: `master_admin`, `master_support` (read everything, no writes: every `.read`, plus `cdr.read`, `analytics.view`, `audit.read`, `monitor.presence` and `billing.read`, its private reads audited), `reseller_admin`, `reseller_support` (read config: the `.read` twin of everything `reseller_admin` manages, plus `audit.read`; H1 still blocks private data), `tenant_admin`, `tenant_supervisor` (monitoring, `analytics.view`, and `queue.read`/`extension.read` for the queues and agents it supervises), `tenant_user` (own extension, voicemail, and recordings where granted). Custom roles are per org.

## 4. Audit

The following are written to `audit_events` via `@cuc/audit`, which publishes to the `AUDIT` stream consumed by identity-service:

- all writes
- all `private` or `secret` reads
- all authentication events
- all monitoring actions

Audit is append-only, and retention is configurable (default 1 year). Tenants can read their own audit trail. They can see master access to their private data, which gives them transparency, but not master-internal details.

## 5. Secrets & crypto

- Envelope encryption (`@cuc/crypto`) protects SIP secrets, trunk credentials, MFA secrets, and conference PINs. Each record is encrypted with a data key, and data keys are wrapped by a KEK from a KMS (Vault Transit or a cloud KMS; local dev uses a file key). Ciphertext carries a key version so keys can be rotated.
- Service DB credentials, the NATS nkeys, and the S3 keys come from the orchestrator's secret store, never from the repo.
- TLS everywhere outside the private network. SIP-TLS (5061) is built; SRTP is not. HTTPS on the edge is built (api-gateway, security headers, HSTS); certificates are issued by ACME and held by org-service ([02 §3.1](02-tenancy-and-branding.md#31-tls-certificates)), with private keys envelope-encrypted. Phone provisioning is refused over plain HTTP by default because the file carries the SIP password.
- Exception to encryption at rest: OpenSIPs' `tls_mgm` table holds SIP proxy private keys in clear (its only database loading mode); limit access to the `opensips` schema.

## 6. Abuse & fraud controls

Toll fraud is the main risk for a PBX. These are in core from Stage 2:

- Per-tenant `max_channels` and outbound calls-per-second limits, enforced in OpenSIPs (`ratelimit`) and FS (`limit` with a Redis backend)
- International calling off by default. Country and prefix allow-lists per tenant.
- SIP brute-force protection: OpenSIPs `pike`, plus fail2ban-style blocking fed from auth failures
- Alerts to the reseller support contact on anomalous outbound spend patterns (calls per minute, new destination countries)

## 7. Compliance hooks

- **Recording consent** (O-12 in [decisions.md](../decisions.md)): policy can play a consent announcement asset before recording begins.
- **Data export and deletion** per tenant, which supports GDPR-style requests and offboarding.
- **Emergency calling:** see G-1.
