# 02 — Tenancy & branding

## 1. Hierarchy

```
Master (platform operator — unbranded, exactly one per deployment)
  └── Reseller (white-labeled; 0..n)
        └── Tenant (brings own trunk; 0..n per reseller)
```

Invariants, enforced in `org-service` and backed by DB constraints where possible:

- There is exactly one `master` org per deployment. It is created by a bootstrap migration or CLI, never through an API.
- A `reseller`'s parent MUST be the master.
- A `tenant`'s parent MUST be a reseller. No tenant hangs directly under the master. If the operator wants to serve end customers directly, it creates an ordinary "house" reseller for them (see decision O-11).
- There is no deeper nesting, and orgs cannot be re-parented in v1. Moving a tenant between resellers is an explicit, audited master-only operation deferred until after v1 (O-12).

## 2. Provisioning responsibilities

| Actor | Can create | Can suspend / delete | Notes |
|---|---|---|---|
| Master | Resellers | Resellers, any tenant | No self-signup exists anywhere |
| Reseller | Tenants (own) | Own tenants | Also configures tenant trunks, domains, and base limits |
| Tenant admin | Users, extensions, call flows, and so on inside the tenant | Same | Cannot create orgs |

Org lifecycle: `active` → `suspended` → `active`, and from either state → `pending_deletion` → `deleted` (hard delete after a retention window, with a data export offered first).

- **Suspending** a tenant blocks console login for that tenant and rejects SIP registration and inbound and outbound calls for its domain. `telephony-config` removes the domain from the OpenSIPs projection. Data is retained.
- **Suspending** a reseller suspends all of its tenants.

## 3. Domains

Every tenant has one **primary SIP domain**, and it is the isolation key at the signaling and media layer.

- The **platform base domain** is deployment configuration (`PLATFORM_BASE_DOMAIN`). It MUST NOT be hard-coded, and no example or default uses a product name.
- A reseller MAY register one or more **reseller base domains**, for example `voice.reseller-brand.com`. Tenant domains are then `{slug}.{reseller-base-domain}`.
- Tenant domain = `{tenant-slug}.{base}` where `base` is the reseller's base domain if set, otherwise the platform base domain.
- Domains are globally unique. Slugs are lowercase DNS labels (`[a-z0-9-]{2,63}`) and are reserved for 90 days after deletion.
- The platform validates DNS ownership (a TXT record) before a reseller base domain is activated. Certificates are issued by ACME (Let's Encrypt) in the background by org-service, one per **hostname that needs one**, not one per tenant (see below).

| Concept | Example | Used by |
|---|---|---|
| Tenant SIP domain / realm | `acme.voice.reseller-brand.com` | OpenSIPs `domain`, digest realm, FreeSWITCH directory domain, XMPP vhost |
| Console hostname (reseller) | `portal.reseller-brand.com` | Brand resolution, CORS, cookies |
| Console hostname (master / unbranded) | `console.{PLATFORM_BASE_DOMAIN}` | Neutral theme |

### 3.1 TLS certificates

| Hostname | Certificate for | Used by |
|---|---|---|
| `sip.<reseller base domain>` (active base domain only) | One per reseller | OpenSIPs (SIP-TLS), for that reseller's tenants |
| `sip.<PLATFORM_BASE_DOMAIN>` | The platform | OpenSIPs, for direct tenants and for tenants of a reseller with no active base domain; also OpenSIPs' `default` row |
| Console hostnames (platform and reseller) | One each | api-gateway (HTTPS) |

- A phone connects to the proxy hostname and keeps the tenant's own domain as its realm (outbound proxy), so a certificate covers only the proxy name, never each tenant domain.
- org-service owns the lifecycle: a reconciler (at startup and every 5 minutes) works out which hostnames need a certificate; a background worker requests each by ACME HTTP-01 (2048-bit RSA), with a lease and a retry backoff of one minute to one day. A failed renewal keeps the held certificate active.
- Certificate chain and ACME account key are stored in org-service's database; private keys are envelope-encrypted (`@cuc/crypto`). Nothing is requested until the platform operator has saved a contact address and agreed to the CA's terms in the console (Certificates section; production or staging directory). Resellers see only their own certificates and why one is failing.
- The HTTP-01 challenge is answered on port 80 by api-gateway (`HTTP_REDIRECT_PORT`), which fetches the answer from org-service. Port 80 must reach the same public address as the SIP edge.
- Delivery: OpenSIPs certificates are projected by telephony-config (`org.certificate.issued`); the gateway asks org-service directly. See [03 §2.3](03-signaling-and-media.md#23-sip-over-tls) and [06](06-services.md).

Changing a tenant's primary domain invalidates stored SIP digest HA1 values, which include the realm. Credentials are therefore stored encrypted and reversibly, as well as in HA1 form, so the HA1 values can be recomputed. See [05 §3.3](05-data-architecture.md#33-pbx-config).

## 4. Isolation layers

| Layer | Mechanism |
|---|---|
| SIP signaling | OpenSIPs authenticates each subscriber against its own domain. Calls between domains never route internally. Inbound trunk traffic is mapped to exactly one tenant. |
| FreeSWITCH | One directory domain and one dialplan context set per tenant, served on demand by `telephony-config`. The `X-Tenant-Id` header is set by OpenSIPs and never trusted from outside. |
| Application | Every tenant-owned row has `tenant_id`, and data access goes through the tenant-scoped repository in `@cuc/db` ([05 §2](05-data-architecture.md#2-tenant-scoping)). |
| Authorization | Every request carries an org context. The policy engine checks org ancestry and data class ([07](07-security-and-permissions.md)). |
| Object storage | A bucket per tenant (or a prefix per tenant; see O-9). Access is only through short-lived presigned URLs issued after an authorization check. |
| Chat | One XMPP vhost per tenant domain. No federation between tenant vhosts by default. |

## 5. Branding

### 5.1 Rules

1. **The Master tier is completely unbranded.** There is no platform product name, operator company name, logo, or brand palette on any surface. That includes the master console, emails, SIP headers, voice prompts, documentation served by the running platform, and error pages. The deployment has **no operator-level branding setting**, by design.
2. **"ConductorUC" is a codebase name only.** It MAY appear in source code, package names, container image names, internal logs, and developer docs. It MUST NOT appear on any user-facing or network-visible surface.
3. **Resellers are the only brand holders.** A reseller brand applies to the reseller's own console sessions and to all of its tenants' surfaces.
4. **Fallback is neutral.** If the owning reseller has no brand configured, or the surface belongs to the master, the neutral presentation applies.
5. Tenants do not have their own brand in v1. A tenant sees its reseller's brand (O-10 covers per-tenant logos as a later extension).

### 5.2 Brand resolution

```
resolveBrand(context):
  if context.org is tenant   -> brand(context.org.parent)  ?? NEUTRAL
  if context.org is reseller -> brand(context.org)         ?? NEUTRAL
  if context.org is master   -> NEUTRAL
  unauthenticated request    -> brand(resellerForHostname(host)) ?? NEUTRAL
```

The hostname mapping (`portal.reseller-brand.com` → reseller) lets the login page render branded before the user authenticates. An unknown hostname renders NEUTRAL.

### 5.3 The neutral presentation

| Element | Neutral value |
|---|---|
| Product label | None. Pages use functional titles such as "Sign in", "Console", "Extensions". |
| Logo | None. The header shows no mark. |
| Favicon | A generic, non-identifying glyph (plain geometric shape) |
| Palette | A neutral grayscale theme with a single system accent color. Must meet WCAG AA contrast. |
| Email sender | `PLATFORM_NOREPLY_ADDRESS` (config), display name empty or functional ("Voicemail") |
| Email footer | None beyond legally required content |

### 5.4 Reseller brand fields

`display_name`, `logo_light`, `logo_dark`, `favicon`, `primary_color`, `accent_color`, `support_email`, `support_url`, `support_phone`, `console_hostnames[]`, `email_from_name`, `email_from_address` (the domain must pass SPF/DKIM verification before use), `sip_user_agent` (optional override string), `legal_footer`.

### 5.5 Brand-leak surfaces checklist

Each of the following MUST resolve to the reseller brand or to neutral, and MUST NOT contain the codebase name, the operator's name, or upstream vendor names where a setting to change them exists.

| Surface | Where it is controlled |
|---|---|
| Console title, favicon, `web/index.html`, `manifest.json`, PWA name, loading screen | `apps/console/web/*` (the Flutter defaults include the project name and "A new Flutter project"), runtime brand bootstrap |
| Login, reset, and error pages | Console + api-gateway |
| HTTP headers (`Server`, `X-Powered-By`) | api-gateway, every service (Fastify sends none by default, keep it that way) |
| API error bodies, OpenAPI `info.title`, and public API docs | `@cuc/http`, api-contracts |
| Emails: subject, From, templates, footer | notification-service templates |
| SIP `User-Agent` / `Server` headers | OpenSIPs `server_header` / `user_agent_header`; FreeSWITCH Sofia `user-agent-string` |
| SDP `o=` username and `s=` session name | FreeSWITCH Sofia profile params (the default is the vendor name) |
| Default system prompts | Stock generic prompts only, with no product name spoken |
| XMPP server identity (disco, version) | XMPP server config |
| TLS certificate CN/SAN | Only tenant, reseller, or platform base domains |
| Hostnames and DNS | `PLATFORM_BASE_DOMAIN`; no product name in defaults |
| Fax header / TSI | fax-service: tenant-configured or blank |
| Exports (CSV/PDF), webhooks `User-Agent` | Owning service |
| Device provisioning files (Stage 8) | provisioning-service templates |

`tools/brand-leak` enforces this in CI (task S0-07). It scans console build output, email templates, telephony config templates, and the OpenAPI documents for a deny-list (`ConductorUC`, `conductor-uc`, `conductoruc`, the operator's company name, and "A new Flutter project"), with an allow-list for code-only paths.
