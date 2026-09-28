# 06 — Service catalog

This refines SAD §7. It adds five services the SAD implies but does not name: **api-gateway**, **pbx-config-service**, **telephony-config**, **call-control**, and **notification-service**. Each has a clear home it would otherwise lack:

- Extensions, DIDs, groups, and queues belong to neither org-service nor callflow-service, so they get pbx-config-service.
- FreeSWITCH and OpenSIPs integration needs one owner, so it gets telephony-config and call-control.
- Brand-aware email is used by voicemail, fax, and identity, so it gets notification-service.

Every service:

- is a Node.js 22 LTS / TypeScript service on Fastify, bootstrapped with `@cuc/http`
- exposes `GET /healthz` (liveness) and `GET /readyz` (dependencies), (S4-13) `GET /metrics` in Prometheus' format (HTTP timings by route pattern, its outbox backlog, and its own gauges; [11 §3](11-operations-console.md)), and (S4-12) `GET /statusz` for the operations console: its checks by name, uptime, memory, and sections it adds (its outbox backlog), internal network only, never a secret or tenant data
- exposes its OpenAPI document at `/openapi.json` (internal only)
- serves public routes under `/v1/...` (reached through api-gateway) and internal routes under `/internal/v1/...` (service-to-service only, mTLS or a service JWT)
- owns its own DB schema and migrations

| # | Service | SAD ref | First stage |
|---|---|---|---|
| 1 | api-gateway | new | S1 |
| 2 | org-service | 7.1 | S1 |
| 3 | identity-service | 7.2 | S1 |
| 4 | pbx-config-service | new | S1 |
| 5 | telephony-config | new (part of 7.4) | S1 |
| 6 | trunk-service | 7.3 | S2 |
| 7 | callflow-service | 7.4 | S2 |
| 8 | call-control | new | S2 |
| 9 | cdr-service | 7.5 | S2 |
| 10 | voicemail-service | 7.7 | S2 (storage) / S5 (email, STT) |
| 11 | notification-service | new | S3 |
| 12 | recording-service | 7.6 | S5 |
| 13 | chat-service | 7.8 | S6 |
| 14 | fax-service | 7.11 | S7 |
| 15 | sms-service | 7.10 | S7 |
| 16 | analytics-service | 7.9 | S7 |
| 17 | provisioning-service | 7.12 | S8 |

---

## api-gateway

**Responsibilities:** the single public HTTP/WebSocket entry point for the console and the public API.

- Verifies JWTs locally (JWKS from identity-service) and API keys (S1-08: `Bearer key_…`, or `ApiKey key_…`, checked with identity-service's `POST /internal/v1/api-keys/verify` and cached 30 s by a hash of the key; forwarded as actor type `apikey` of the key's org). Every service's permission guard then checks the key's own permissions (`GET /internal/v1/orgs/{o}/api-keys/{id}/permissions`), refuses H4 routes (`api_key_not_allowed`) and scoped or self-service routes, which are about a person. A revoked key stops within about 35 s.
- Builds the **request context** (`actor`, `orgId`, `orgType`, `resellerId`, `tenantId` of the target path) and forwards it to services as signed internal headers.
- Resolves hostname → reseller for unauthenticated routes, which drives the branded login page.
- Rate limits per IP, per user, and per API key (Redis).
- Hosts the WebSocket hub for live events (presence, active calls, wallboards). It subscribes to NATS and filters each message by the subscriber's permissions.
- Handles CORS for the console hostnames, which are known from `console_hostnames`.
- Serves **HTTPS** when given a certificate (see the table below), sets security headers on every response, and can host the built console from its own origin.
- Answers the certificate authority's ACME HTTP-01 challenge on the plain-HTTP port, fetching the answer from org-service.

| Setting | Effect |
|---|---|
| `TLS_CERT_FILE` + `TLS_KEY_FILE` (both or neither) | Default certificate, for a client that names no host or one with no certificate. TLS 1.2 minimum. |
| `TLS_CERT_DIR` | One certificate per hostname chosen by SNI: `<dir>/<hostname>/fullchain.pem` + `privkey.pem`, wildcard in `_.<domain>`. Renewed files are picked up within a minute. |
| `TLS_FROM_ORG_SERVICE` (needs `INTERNAL_SERVICE_TOKEN`) | Console hostnames' certificates come from org-service (console-purpose certificates only), cached in memory and rechecked at most once a minute per name. Files in `TLS_CERT_DIR` win. |
| `HTTP_REDIRECT_PORT` | Plain-HTTP listener (port 80 in production): answers `/.well-known/acme-challenge/<token>` from org-service, redirects everything else with 308 to HTTPS. |
| `HSTS_MAX_AGE_SECONDS` | Default one year; 0 turns `Strict-Transport-Security` off. Sent only when the request arrived over HTTPS. |
| `REQUIRE_HTTPS_FOR_PROVISIONING` | Default on: phone provisioning over plain HTTP gets a 403 (the file carries a SIP password). Development over `http://localhost` turns it off. |
| `CONSOLE_DIR`, `CONSOLE_CONNECT_SOURCES` | Serve the built Flutter web console (`flutter build web --release --no-web-resources-cdn`) under a strict Content-Security-Policy; other origins the console may call (the object store) are listed in `CONSOLE_CONNECT_SOURCES`. Unknown extension-less paths get `index.html`. With the realtime hub on, the policy's `connect-src` also names `wss://` (or `ws://`) plus the host the page was requested on, since not every browser lets `'self'` cover WebSockets. |

Responses carry `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy` and `Permissions-Policy`; API responses are `Cache-Control: no-store`. Route table entries added for certificates and provisioning: `/v1/platform/acme-settings`, `/v1/platform/certificates` (org), `/v1/platform/security-settings` (identity), `/v1/public/provision`, `/v1/tenants/*/devices`, `/v1/tenants/*/sip-endpoint` (pbx). S5-15 adds the service key `call` (call-control, `CALL_CONTROL_URL`, now always required) with `/v1/tenants/*/calls` and `/v1/tenants/*/me/live-calls` (the recording buttons on live calls; `/me/calls` stays cdr-service's call history), and call-control to the platform health page.

### Realtime hub (S5-08)

`GET /v1/ws` is a WebSocket on the same listener as the API (`services/api-gateway/src/realtime/`). It streams live calls, presence and queue state to the console, filtered per subscriber with the same rules as every route. On by default (`REALTIME_ENABLED`); it needs NATS, `CALL_CONTROL_URL` and `INTERNAL_SERVICE_TOKEN`.

**Connecting.** Before the upgrade, a browser's `Origin` must be the gateway's own host or a `CONSOLE_HOSTNAMES` entry (403 otherwise), and the address must be under `REALTIME_MAX_CONNECTIONS_PER_IP` (429). A plain `GET` gets 426. The route is public at the HTTP layer because a browser cannot send `Authorization` on a WebSocket and a token in the URL would be logged; the hub authenticates the first message instead.

**Protocol, version 1.** Every frame is one JSON text message with a `type`.

| Direction | Message | Meaning |
|---|---|---|
| client → | `{type:"auth", token}` | The access token. First message, within `REALTIME_AUTH_TIMEOUT_MS`; sent again with a fresh token before the old one expires. |
| client → | `{type:"subscribe", topic, id?}`, `{type:"unsubscribe", topic, id?}` | `id` is echoed back. Subscribing again to a held topic replaces it (a fresh snapshot). |
| ← server | `{type:"authenticated", v:1, expiresAt}` | After each accepted `auth`. |
| ← server | `{type:"subscribed", topic, id?}`, then `{type:"snapshot", topic, data}`, then `{type:"event", topic, event}` … | The current state, then each change after it, in order. |
| ← server | `{type:"unsubscribed", topic, id?, code?}` | After an `unsubscribe`, or, with `code`, when the server ends a subscription (`permission_denied` after a revocation; `unavailable` when the event feed was lost: subscribe again later). |
| ← server | `{type:"error", code, message, topic?, id?}` | A refused request: `bad_message`, `unknown_type`, `unknown_topic`, `not_subscribed`, `too_many_subscriptions`, `forbidden` (tenant boundary or ancestry), `reseller_private_data_denied` (H1), `permission_denied`, `unavailable`. |

Close codes: 4401 (`Authentication required`, `Invalid token`, `Session expired`: get a fresh token and reconnect), 4403 (`Identity changed`: a later token named someone else; sign in again), 1001 (gateway shutting down: reconnect), 1008 (too many messages), 1009 (frame over `REALTIME_MAX_MESSAGE_BYTES`), 1013 (too many connections for the person, or the client fell more than `REALTIME_MAX_BUFFERED_BYTES` behind). Reasons are plain and never name the product. The gateway pings every `REALTIME_HEARTBEAT_INTERVAL_MS` and drops a connection that did not answer the last ping.

**Topics.** Each declares a permission and a data class, as a route does:

| Topic | Permission | Class | Snapshot → events |
|---|---|---|---|
| `tenant:{t}:calls` | `monitor.calls` | private | `{calls:[LiveCall]}` → `call.started {call}`, `call.updated {callUuid, changes}`, `call.ended {callUuid, hangupCause}` |
| `tenant:{t}:presence` | `monitor.presence` | config | `{extensions:[{extension, state}]}` (every extension of the tenant, in number order; without `TELEPHONY_CONFIG_URL`, the busy ones only) → `presence.changed {extension, state}`; state `on_call`, `ringing`, `offline`, `dnd` or `idle` (S5-10, G-122) |
| `tenant:{t}:queues` | `queue.read` | config | `{queues:[LiveQueue]}` → `queues.changed {queues}` (the whole list again, S9-13); counts and statuses only, never a caller's number. Read from call-control's `GET /internal/v1/tenants/{t}/queues` on subscribe, again 250 ms after any `call.queue.*` or `call.channel.*` event of the tenant, and every 3 s while anyone on the replica watches (a caller hanging up while waiting raises no queue event); sent only when it changed. Shared by the attendant console, monitoring and wallboards (S7-06) |
| `tenant:{t}:user:{u}:calls` (S5-15) | `self.history` | private | as `calls`, but only person `u`'s own legs (those whose `extension` is their extension's number, from pbx-config-service's `/internal/v1/tenants/{t}/users/{u}/extension`, cached 30 s) and the legs bridged to them. Only `u` may subscribe: a person of tenant `t` whose id is `u` (not a colleague, an administrator or the master: `forbidden`). No linked extension: `no_linked_extension`. |
| `tenant:{t}:user:{u}:supervised` | any of `monitor.listen`, `monitor.whisper`, `monitor.barge`, checked by the hub against the person's grants; that person only | private | the live calls they may monitor (G-119 (1)): the tenant's `calls` shape, limited to every call when they hold one of those across the tenant, else the legs on the extensions and in the queues they are granted it on (plus those queues' agents, via pbx-config-service's `POST /internal/v1/tenants/{t}/monitor-scope`) and the legs bridged to them; a changed scope ends the view (`unavailable`), none refuses it (`permission_denied`); audited |

A `LiveCall` is one channel (leg): `callUuid`, `direction` (`inbound`: the leg called in to the media node; `outbound`: the node placed it), `state` (`ringing`, `answered`, `held`), `from`, `to`, `startedAt`, `answeredAt`, `bridgedTo` (the other leg), `recording` (`on`, `off`, `paused`), `controls` (S5-15: which recording buttons can work, `on_demand`, `pause` or `none`), and `extension` (S5-15: the tenant extension the leg belongs to when call-control vouches for it, else null), `queueId` (G-119 (3)) and `parked` (S9-14: `{parkingLotId, slot}` while the leg waits in a parking lot, else null; `call.updated` carries it when `mod_valet_parking` parks or releases the leg). The media node is not sent. `call.updated` changes may carry `state`, `answeredAt`, `bridgedTo`, `recording` and `controls`. The record, stop, pause and resume buttons (S5-15) read `recording` and `controls` and act by `callUuid` (call-control below).

**Authorization.** On subscribe, and again every `REALTIME_PERMISSION_RECHECK_MS`: org ancestry with H2 (a tenant's people reach only their tenant; a reseller its own tenants, asked of org-service's `/internal/v1/orgs/{id}/lineage` and cached; the master any tenant), then H1 (a reseller never gets a private topic), then the topic's permission through identity-service's `/internal/v1/orgs/{org}/users/{user}/permissions` (`@cuc/http`'s `createRemotePermissionResolver`, cached `REALTIME_PERMISSION_CACHE_TTL_MS`). A lookup that fails refuses (`unavailable`). A revoked permission ends the subscription within the recheck interval plus the cache TTL. Every subscription to a private topic is audited (`audit.event.recorded`, action `realtime.calls.subscribed` or `realtime.mycalls.subscribed`, published directly as other reads are); if it cannot be audited it is refused. A person's own calls topic also looks their extension up again on each recheck and ends the subscription (the client subscribes again) if it changed.

**Events.** The hub reads the `CALL` stream (`call.>`) with an ordered consumer: ephemeral, owned by the gateway process, starting at new messages. Each event is routed by `orgContext.tenantId` to that tenant's topics and sent only to their subscribers; an event with no tenant goes nowhere. A `calls` subscription starts with call-control's `GET /internal/v1/tenants/{t}/calls`, and events arriving meanwhile wait until the snapshot is sent. For `user:{u}:calls` the hub keeps the tenant's legs while anyone on the replica watches their own calls in it (as it does for presence), because which legs a person is shown depends on the legs bridged to theirs; a leg once shown stays until it ends, and one that joins a person's call later is sent as `call.started` with its state then. Presence is derived from the same calls (see below). If the feed stops, every subscription is ended with `unavailable` and clients subscribe again when it is back.

**Operations console (S4-12, G-124).** `GET /v1/platform/overview` (`platform.observe`, master only), served by the gateway itself: every service's `/statusz` (those it forwards to, telephony-config, and `PLATFORM_STATUS_TARGETS`), call-control's nodes joined with telephony-config's dispatcher view, the SIP edge, JetStream streams and durable consumers (its own NATS connection), Redis (`INFO`), MariaDB (through telephony-config) and NATS (`NATS_MONITOR_URL`). Each source has 2 s and fails alone. See [11](11-operations-console.md).

**Presence, as built (S5-08, S5-10, G-122).** Two sources. Call state comes from live calls: a leg's extension is its caller for an inbound leg and its callee for an outbound one, when that number has an extension's shape (2 to 6 digits). Registration and do not disturb come from telephony-config: the snapshot asks its `GET /internal/v1/tenants/{t}/presence` (every extension with `registered` and `dnd`) alongside call-control's live calls, and `call.presence.changed` events follow each change. An extension is `on_call`, else `ringing`, else `offline` (no phone registered), else `dnd`, else `idle` (registered and free); only the tenant's real extensions appear, so an outside caller ID never does. Without `TELEPHONY_CONFIG_URL` presence is calls only (`ringing`, `on_call`, `idle`, where idle does not say registered), and the snapshot lists the busy extensions only. BLF dialog state (S2-17) is not used.

**Replicas.** Each gateway replica runs its own hub: it reads every event itself and serves only its own sockets, so replicas need no coordination and load balancers need no sticky sessions, only WebSocket upgrade support and an idle timeout above the heartbeat interval. A client that reconnects to another replica subscribes again and gets a fresh snapshot. Connection limits are per replica.

**Must not** contain business logic or authorization decisions beyond authentication and coarse route-level checks. Services authorize. The realtime hub is the one place the gateway authorizes data itself, because it relays events rather than proxying to the service that owns them; it does so with the shared rules (`@cuc/authz`'s H1, identity-service's permission lookup), never rules of its own.

## org-service

**Owns:** orgs (master, reseller, tenant), domains, brands, console hostnames, org limits.

**Public API (examples):**

- `POST /v1/resellers` (master)
- `GET/PATCH /v1/resellers/{id}`
- `POST /v1/resellers/{id}/tenants` (reseller or master)
- `GET/PATCH /v1/tenants/{id}`
- `POST /v1/tenants/{id}:suspend` and `:resume`
- `POST /v1/resellers/{id}/base-domains` and `:verify`
- `PUT /v1/resellers/{id}/brand`
- `GET /v1/resellers/{id}/certificates` and `GET /v1/platform/certificates` (`domain.read`; status and last error per hostname)
- `GET/PUT /v1/platform/acme-settings` (`domain.read`/`domain.manage`; contact address, production or staging, agreement to the CA's terms)
- `GET/PUT /v1/platform/network-settings` (`domain.read`/`domain.manage`, master only; the platform's public IP address or hostname, audited as `platform.network_settings.updated`) and `GET /v1/resellers/{id}/dns-records` (one A, AAAA or CNAME record per name the platform keeps a certificate for, so a reseller knows what to publish; migration 005, table `platform_network`)
- `GET /v1/public/brand?host=` (unauthenticated; returns reseller brand or `{"neutral": true}`)

**Events:** `org.reseller.created|updated|suspended|resumed|deleted`, `org.tenant.*` (same verbs), `org.domain.added|removed`, `org.brand.updated`, `org.certificate.issued` (a certificate was issued or renewed; carries no key).

**Certificates (G-105):** also owns the TLS certificate lifecycle (tables `tls_certificates`, `acme_challenges`, `acme_accounts`, `acme_settings`; overview in [02 §3.1](02-tenancy-and-branding.md#31-tls-certificates)). A reconciler (startup and every 5 minutes) decides which hostnames need one; a background worker (`certificate-worker`, `acme-issuer`) requests them from Let's Encrypt over HTTP-01 once the console's ACME settings are complete. `ACME_DIRECTORY_URL` points it at another ACME server (tests use Pebble). Private keys are envelope-encrypted with `CRYPTO_KEKS`. Internal routes (service token): `GET /internal/v1/tenants/{id}/sip-proxy` (the proxy hostname for a tenant), `GET /internal/v1/certificates` and `/{fqdn}` (chain and key, for consumers), `GET /internal/v1/acme/challenges/{token}`.

**Depends on:** identity-service (creating the initial admin user for a new reseller or tenant), storage (brand assets), Let's Encrypt (or `ACME_DIRECTORY_URL`).

## identity-service

**Owns:** users, credentials, MFA, sessions, roles, grants, API keys, the audit store.

**Public API:**

- `POST /v1/auth/login`, `/v1/auth/mfa/verify`, `/v1/auth/refresh`, `/v1/auth/logout`
- `POST /v1/auth/password-reset` (request and confirm)
- `/v1/orgs/{orgId}/users` (CRUD)
- `/v1/orgs/{orgId}/roles`, `/v1/orgs/{orgId}/grants`, `/v1/orgs/{orgId}/api-keys` (S1-08: list, create, revoke; `apikey.manage`, class `secret`; the key is in the create answer only; audited `apikey.created`/`apikey.revoked`)
- `GET /v1/orgs/{orgId}/audit-events`
- `GET /.well-known/jwks.json`
- `GET/PUT /v1/platform/security-settings` (`platform.observe`/`platform.operate`, master only): whether the master's own users must use two-step verification (D-012 as amended). Off on a fresh install; turning it off again takes a step-up code (G-100). Audited (`platform.security_settings.updated`)

**Internal:** `POST /internal/v1/authz/check` (batch). Services normally evaluate authorization with the `@cuc/authz` library against the token's claims plus a cached grant set, and call this endpoint only for fine-grained grants that aren't in the token.

**Reset and invitation links (G-55):** `POST /internal/v1/orgs/{orgId}/password-resets/{resetId}/link` and `POST /internal/v1/orgs/{orgId}/invitations/{invitationId}/link`, called by notification-service with the service token when it sends the email. A reset request or invitation is created without a token; this call creates one, stores its SHA-256 in place of any earlier one (so the link of an email that was retried stops working) and returns the raw token once, with the request's own expiry: `200 {token, expiresAt}`. `404` when there is no such reset or invitation in that org; `409` `link_used`, `link_expired` or `user_inactive`. No event, outbox row or backup holds a usable token.

**Events:** `identity.user.created|updated|disabled|deleted`, `identity.user.password_reset_requested`, `identity.invitation.created`, `identity.invitation.accepted`, `identity.user.mfa_reset`, `identity.grant.changed`. An invitation may name the extension waiting for the person (`extensionId`, S9-07; refused for a reseller, `reseller_cannot_link_user`); `identity.invitation.accepted` carries it, and pbx-config-service links the extension to the new account if no one else has it. The reset and invitation events carry ids only (version 2, G-55).


## pbx-config-service

**Owns:** extensions, SIP credentials, devices, DIDs, ring and hunt groups, queues and agents, parking lots, conference rooms, schedules, media assets, emergency locations.

**Public API:** `/v1/tenants/{t}/extensions`, `/devices`, `/sip-endpoint`, `/dids`, `/ring-groups`, `/pickup-groups` (S9-18: who may answer whose ringing calls; `group.read`/`group.manage`), `/queues`, `/parking-lots`, `/conference-rooms`, `/schedules`, `/media-assets` (upload via presigned URL, then `:finalize`, which transcodes to 8 kHz/16 kHz WAV; `/{id}/download-url` plays a ready one back, G-80).

**Events:** `pbx.{entity}.created|updated|deleted` for each entity above. **Consumes** `org.domain.added` (recompute SIP digests for a tenant's new realm) and `identity.invitation.accepted` (S9-07: link the invited person to the extension waiting for them).

**Phone setup (G-102, G-103, G-105):**

| Route | Purpose |
|---|---|
| `GET /v1/tenants/{t}/sip-endpoint` (`extension.read`) | What a phone is told: `server` and `realm` (the tenant's primary domain; 409 if none), `port`/`tlsPort`, `transports`, and `outboundProxy` (the tenant's SIP proxy hostname from org-service, only once its certificate is active, otherwise null). |
| `/v1/tenants/{t}/devices` (`extension.read` to list and view, `extension.manage` to change) | A Yealink phone by MAC (unique across all tenants) and the extension it registers as. |
| `POST .../devices/{id}/provisioning-credentials` (`secret.reveal`, audited) | Per-device password, shown once; only its SHA-256 is kept. |
| `GET /v1/public/provision/yealink/{file}` (public; authenticates itself) | `<mac>.cfg` and the model-wide file. HTTP Basic with either the platform-wide credential (`PROVISIONING_USERNAME` + `PROVISIONING_PASSWORD`, set together) or the device's own; every failure is the same 401. The file sets account 1, the transport, and the outbound proxy (or turns it off), and asks the phone to refetch every 1440 minutes. |

Settings: `SIP_PUBLIC_PORT` (5060), `SIP_PUBLIC_TLS_PORT` (5061), `SIP_PUBLIC_TRANSPORTS` (code default `udp,tcp`; compose sets `udp,tcp,tls`; put `tls` first in production), `PROVISIONING_BASE_URL` (unset: provisioning URLs are null). The platform-wide credential does not isolate one tenant's phones from another's (a MAC is not a secret); see G-103. Only Yealink is supported.

**Call handling (G-109):** `GET|PUT /v1/tenants/{t}/extensions/{id}/call-handling` (`extension.read`/`extension.manage`, config class): do not disturb, forward always, busy, no answer and unreachable, and up to five simultaneous ring destinations (an extension, a voicemail box or an external E.164 number). Table `extension_call_handling`, event `pbx.call_handling.updated`; telephony-config mirrors it and applies it in the dialplan for calls to that extension (design and safety limits in decisions G-109). Internal routes `GET /internal/v1/tenants/{t}/extensions/{id}/call-handling` and `.../tenants/{t}/call-handling` serve telephony-config.

**Notes:**

- On create, generates a SIP password (never returned after creation except through a `:reveal` action that requires a permission and is audited) and computes HA1 for the tenant realm.
- Validates extension numbering against the tenant's dial plan (no collisions with feature codes, parking slots, conference numbers, or queue numbers).

## telephony-config

**Owns:** the read model of everything FreeSWITCH and OpenSIPs need, the `opensips` schema projection, and the xml_curl endpoints.

**Interfaces:**

- `POST /fs/directory`, `/fs/dialplan`, `/fs/configuration`, reachable only from FS nodes (network ACL + shared token). See [03 §3.1](03-signaling-and-media.md#31-xml_curl-endpoints-telephony-config).
- **Hold music (S9-19, G-125):** every tenant call's dialplan exports `hold_music` next to `cuc_tenant_id`: the tenant's hold music (its most recently changed ready `moh` media asset, from pbx-config-service's `GET /internal/v1/tenants/{t}/hold-music`, cached 30 s, played through `http_cache` like any prompt), or a neutral soft tone (`tone_stream://%(250,4750,440);loops=-1`) when it has none or the lookup fails. A phone's own hold, a parked caller (`valet_hold_music=${hold_music}`) and a caller waiting during an attended transfer all hear it.
- OpenSIPs projection: `domain`, `subscriber`, `address`, `dr_gateways`, `dr_rules`, `dr_groups`, `registrant`, `dispatcher`, `tls_mgm`, plus MI reload calls.
- **Presence (S5-10, G-122):** every `PRESENCE_POLL_INTERVAL_MS` (5 s) it asks OpenSIPs for every registration (MI `ul_dump`), works out each extension's `registered` (its SIP username at its tenant's domain has a live contact) and `dnd` (its call handling), and for each that changed since it last announced (`extension_presence`) enqueues `call.presence.changed` `{extensionId, extension, registered, dnd}` in the same transaction. A pass that cannot ask OpenSIPs changes nothing. `GET /internal/v1/tenants/{t}/presence` (service token) serves the tenant's extensions as last announced, for api-gateway's presence snapshot.
- **Certificates:** `certificate-sync` consumes `org.certificate.issued` and runs a periodic reconcile. Each active SIP proxy certificate becomes a `tls_mgm` server row named for its hostname; the platform's own is also the `default` row. It then calls `tls_reload`. Needs `ORG_SERVICE_URL` and `INTERNAL_SERVICE_TOKEN` to fetch the material. See [03 §2.3](03-signaling-and-media.md#23-sip-over-tls).

- **Operations console (S4-12, G-124):** `GET /internal/v1/platform/status` (service token): OpenSIPs' statistics and uptime over MI, the FS pool as OpenSIPs holds it (state and weight), and MariaDB's figures. Applies `call.node.weight_changed` to the node's dispatcher rows, then `ds_reload`.

**Consumes:** see [05 §5](05-data-architecture.md#5-events).

**Invariant:** after any config event, the projection and cache purge MUST complete within 5 s (p95). A reconciliation job compares the read model with the source services every 15 min and repairs drift.

## trunk-service

**Owns:** tenant trunks, trunk IPs, outbound routes, emergency routes. Credentials use envelope encryption through `@cuc/crypto`.

**Public API:** `/v1/tenants/{t}/trunks`, `/outbound-routes`, `/emergency-routes`, and `/v1/tenants/{t}/trunks/{id}:status`, which returns registration state (read from OpenSIPs via telephony-config's internal API).

Resellers configure trunks for their tenants. Tenant admins can view trunks and, with the `trunk.manage` grant, edit them. Reads declare `trunk.read`, which `trunk.manage` implies (G-10).

**Events:** `trunk.trunk.created|updated|deleted`, `trunk.route.changed`.

## callflow-service

**Owns:** flows, flow versions (graph + IR), entry points.

**Public API:**

- `/v1/tenants/{t}/flows` (CRUD). S9-10: `PATCH .../flows/{id}` renames; `DELETE .../flows/{id}` (`callflow.publish`, since it changes live routing) removes a flow and its versions, refused with `409 flow_in_use` while another flow's draft or live version jumps to it, and emits `callflow.flow.deleted`. Numbers still pointing at a deleted flow are pbx-config-service's; the console lists them before deleting. Reseller administrators edit and publish flows too (D-020).
- `/v1/tenants/{t}/flows/{id}/versions/{v}` (get or put the draft graph)
- `:validate`, which returns a list of issues with node IDs
- `:publish`, which compiles the IR and makes the version immutable
- `:rollback`, which repoints to an earlier published version

**Internal:** `GET /internal/v1/flows/{id}/versions/{v}/ir`, called by FS nodes with a shared token. The response is immutable and cacheable.

**Library:** `@cuc/callflow-ir` holds the IR JSON schema, the graph→IR compiler, and the validator. It's shared with the console's validation logic by generating Dart types from the same JSON Schema.

**Events:** `callflow.flow.published`.

## call-control

**Owns:** ESL connections to FS nodes, the Redis call registry, affinity leases, and call-control commands.

**Internal API:**

- `:hangup`, `:transfer`
- `POST /internal/v1/originate`
- `GET /internal/v1/tenants/{t}/calls` (live calls from Redis, one entry per leg; built in S5-08 for api-gateway's realtime hub; S5-15 adds `recording: paused`, `controls` and `extension`)
- `GET /internal/v1/nodes`, `GET /internal/v1/nodes/{id}` (each FS node's status, `draining`, calls and leases) and `POST /internal/v1/nodes/{id}/drain` and `/undrain` (S4-02, [G-123](../decisions.md): out of rotation for new calls and leases, leases handed over at once; emits `call.node.drain_changed`, which telephony-config applies to OpenSIPs' dispatcher)

**Operations console (S4-12, G-124), through api-gateway:** `POST /v1/platform/nodes/{id}/drain` and `/undrain`, `PUT /v1/platform/nodes/{id}/weight` `{weight: 1..999}` (`platform.operate`, master only), each audited in the transaction of its event (`call.node.drain_changed`, `call.node.weight_changed`). `fsnode:{id}` also keeps what each FreeSWITCH `HEARTBEAT` reports (sessions, maximum, idle CPU, rate, uptime), which `GET /internal/v1/nodes` returns.

**Public API (S5-15, through api-gateway; G-111 (3), G-120):** the record, stop, pause and resume buttons for a live call, with exactly the rules of the in-call feature codes `*1` and `*2`.

| Route | Permission | Class | Who |
|---|---|---|---|
| `POST /v1/tenants/{t}/calls/{callUuid}/recording` `{action: start\|stop\|pause\|resume}` | `recording.control` | private | a supervisor or administrator, any live call of the tenant |
| `POST /v1/tenants/{t}/me/live-calls/{callUuid}/recording` (same body) | `self.recording` | private | a person, only a leg on their own extension (from pbx-config-service by the signed actor id, never from the request) |

`callUuid` is either leg of the call. call-control finds the leg in its registry (tenant must match; for `/me` its vouched `extension` must be the person's), then over ESL to the node holding it reads, with `uuid_getvar`, `cuc_rec_owner` (the channel that owns the recording) and on the owner `cuc_tenant_id` (must match), `cuc_rec_ctx` (the call context telephony-config set; absent means no rule allows on demand) and `cuc_recording_id`. It asks recording-service's `POST /internal/v1/recordings/control` with the explicit `action` and the person as `actor`; recording-service checks the call's rules, writes the change and its audit event (actor type `user`) in one transaction, then answers. Only then does call-control run `uuid_record <owner> start|stop|mask|unmask <spool path>` (the path built like telephony-config's, `RECORDING_SPOOL_DIR`), then `uuid_setvar` of `cuc_recording_id` for a start or stop, or `sendevent CUSTOM cuc::recording` for a pause or resume. One action at a time per call in the process.

Answers: 200 `{result: started|stopped|paused|resumed, recordingId, recording: on|off|paused}`; 404 `call_not_found` (not a live call of this tenant, or for `/me` not the person's own leg), `no_linked_extension`; 409 `recording_not_allowed`, `rule_recording` (a rule recording is never stopped), `not_recording`, `already_recording`, `already_paused`, `not_paused`; 403 `permission_denied`, `tenant_boundary`, `reseller_private_data_denied` (H1), `self_service_only`, `people_only` (an API key or service); 503 `recording_unavailable` (recording-service could not be asked: nothing was done, since nothing unaudited is done), `media_unavailable` (no ESL connection to the node), `media_node_failed` (audited, but `uuid_record` failed on the node; a start that never ran is marked failed by recording-service's pending sweep). Details are neutral and name neither the product nor FreeSWITCH.

**Emits:** `call.channel.created|identified|answered|bridged|held|unheld|recording_started|recording_stopped|recording_paused|recording_resumed|hungup`, with the tenant in `orgContext` whenever it is known. S5-15: `recording_paused`/`_resumed` come from `CUSTOM cuc::recording` (`Recording-Call-UUID` the owner channel, `Recording-Action` `paused` or `resumed`; not `Unique-ID`, since `sendevent` queues an event naming a live channel there to that channel instead of firing it), which `recording_control.lua` fires after a feature code's mask or unmask and call-control fires with `sendevent` after a button's (FreeSWITCH raises nothing for a mask); if the node will not take the `sendevent`, call-control handles the event itself in the node's order. `created` and `identified` carry `extension` (an inbound leg from a registered phone, as OpenSIPs' `X-Tenant-Id` vouches, is its SIP From user; an outbound leg is the extension it rang; a trunk caller never is) and `controls`; `answered` and `bridged` carry `controls` when the channel has `cuc_rec_controls` (all optional fields within schema version 1). A call from a trunk has no tenant at `created` and learns it from `cuc_tenant_id` (which the dialplan exports to every leg it bridges to) on its later events; a leg that never names its tenant takes the tenant of the leg bridged to it. The first time a channel's tenant becomes known after `created`, `call.channel.identified` carries the whole call as it stands, before the event that named the tenant, so a live view that routes by tenant sees the call start before it changes. Each node's ESL events are handled one at a time in the order FreeSWITCH raised them, and outbox ids are UUIDv7 increasing within a process, so the bus carries a call's events in order. G-119 (3): `call.channel.queued` `{callUuid, nodeId, queueId}` when `mod_callcenter` puts a leg in a queue (`member-queue-start` for the caller, `bridge-agent-start` for the answering agent; the registry keeps `queue` on the leg, and the live feed shows it as `queueId`), and `call.queue.agent_status_changed` `{agentName, extension, status}` / `call.queue.agent_state_changed` `{agentName, extension, state}` from `agent-status-change` / `agent-state-change` (header names confirmed live), with the tenant resolved from the agent's domain (org-service `GET /internal/v1/tenant-domains/{fqdn}`, cached). S9-14: `call.channel.parked` `{callUuid, nodeId, parkingLotId, slot}` and `call.channel.unparked` `{callUuid, nodeId}` from `CUSTOM valet_parking::info` (`Action` `hold`, or `bridge`/`exit`; `Valet-Lot-Name` `<lot id>@<domain>`, `Valet-Extension` the slot; confirmed live); the registry keeps `parkedLot`/`parkedSlot` and the live feed shows `parked`. S4-02: `call.node.drain_changed` `{nodeId, draining}` when an operator drains an FS node or returns it to service. Also `call.lost`, `call.queue.*` (from `mod_callcenter` events), `call.conference.*`, `call.park.*`. Events are rate-shaped per tenant.

**Monitoring (S5-09, G-121):** listen, whisper and barge, from the supervisor's own phone. Browser-based listening would need WebRTC, which is out of scope (O-14).

| Route | Permission | Class | Who |
|---|---|---|---|
| `POST /v1/tenants/{t}/calls/{callUuid}/listen` | `monitor.listen` | private | held across the tenant (`tenant_supervisor`, or a grant on the org): any call; a grant on `extension:X`: calls X is on; on `queue:Q1`: calls in Q1 and calls whose target is an agent of Q1 |
| `POST /v1/tenants/{t}/calls/{callUuid}/whisper` | `monitor.whisper` | private | the same |
| `POST /v1/tenants/{t}/calls/{callUuid}/barge` | `monitor.barge` | private | the same |

The routes declare `scopedPermission` (`@cuc/http`): the permission guard applies H1 and the tenant boundary, and call-control checks the permission against the call. `callUuid` is either leg. call-control finds it and its bridged partner in the registry (tenant must match), and joins the supervisor to the tenant's own party (the leg with an extension: for a queue call, the agent). For a holder of scoped grants only, it asks pbx-config-service (`GET /internal/v1/tenants/{t}/extensions/by-number/{number}`) which extension each leg is and which queues the target answers as an agent, and reads `cc_queue` on both legs over ESL. It rings the person's own extension (pbx-config-service, from the signed actor), after writing `call.monitor.{mode}` to the audit outbox: `bgapi originate {sip_route_uri=sip:<OPENSIPS_SIP_URI>,origination_caller_id_name=Listen|Whisper|Barge,eavesdrop_enable_dtmf=false,...}sofia/internal/<ext>@<tenant domain>` on the node that holds the call, into `&eavesdrop(<target>)` (whisper adds `eavesdrop_whisper_aleg=true`, so only the target hears the supervisor) or `&three_way(<target>)` for barge. The tenant domain comes from org-service. `eavesdrop_enable_dtmf=false` stops a listener switching to whisper or barge with a digit.

Answers: 200 `{mode, callUuid, monitorCallUuid}` once the phone has answered and joined; 404 `call_not_found`, `no_linked_extension`; 403 `insufficient_permission` (not for this call), `people_only`, `tenant_boundary`, `reseller_private_data_denied` (H1); 409 `call_not_answered`, `own_call`, `phone_unreachable`, `phone_not_answered`; 503 `permissions_unavailable`, `monitor_unavailable`, `media_unavailable` (nothing was done) and `media_node_failed`.

**Moving live calls (S9-12, G-125):** hang up, transfer, park and pick up, for the console and the attendant console, and a person's own, with click-to-call. Every call the person takes part in rings their own phone (O-14).

| Route | Permission | Class | What |
|---|---|---|---|
| `POST /v1/tenants/{t}/calls/{callUuid}/hangup` | `call.control` | private | `uuid_kill` the leg |
| `POST /v1/tenants/{t}/calls/{callUuid}/transfer` `{to}` | `call.control` | private | blind: the named leg goes to `to` |
| `POST /v1/tenants/{t}/calls/{callUuid}/park` `{parkingLotId}` | `call.control` | private | the named leg goes to the lot's first free slot; answers `{slot}` |
| `POST /v1/tenants/{t}/calls/{callUuid}/pickup` | `call.control` | private | a leg ringing a phone: the person's own phone rings, and takes the call |
| `POST /v1/tenants/{t}/me/live-calls/{callUuid}/hangup` | `self.calls` | private | their own leg |
| `POST /v1/tenants/{t}/me/live-calls/{callUuid}/transfer` `{to, attended?}` | `self.calls` | private | the other party on their own leg, blind; or attended: the other party waits |
| `POST /v1/tenants/{t}/me/live-calls/{callUuid}/transfer/complete` and `/cancel` | `self.calls` | private | join the waiting party to whoever answered, or go back to them |
| `POST /v1/tenants/{t}/me/live-calls/{callUuid}/park` `{parkingLotId}` | `self.calls` | private | the other party on their own leg |
| `POST /v1/tenants/{t}/me/dial` `{to}` | `self.calls` | private | click-to-call; dialing a slot takes back the call parked there |

`to` is what a phone could dial: `^\+?[0-9*#]{1,32}$`. A transfer or park sends the leg back through the tenant's own dialplan, so every rule a phone's call meets applies (extensions, groups, flows, outside numbers with the toll-fraud limits, emergency routing): `uuid_setvar_multi` sets `sip_h_X-Call-Direction=internal` and `sip_h_X-Tenant-Id`, the variables OpenSIPs' trusted headers give a phone's call (03 §3.2), then `uuid_transfer <leg> <to> XML public`. The caller ID is left alone, so whoever answers sees the original caller. A park picks the first slot `valet_info <lot>@<domain>` does not list, reserved in Redis for 15 s (`parkslot:{t}:{lot}:{slot}`, `SET NX`), since parking into a taken slot would retrieve that call instead; a lot whose lease is on another node than the call is refused (`parking_lot_elsewhere`, until calls move between nodes, S4-05). A pickup reads the ringing leg's `originating_leg_uuid` (or `call_uuid`) and rings the person's phone into `&intercept(<caller's leg>)`, which stops the ringing phone. Click-to-call rings the person's phone (`bgapi originate ... &park()`, through OpenSIPs as for monitoring), then sets the same variables plus `sip_from_user` and the effective caller ID to their extension, and sends it through the dialplan. An attended transfer sets `park_after_bridge=true` on the person's leg, keeps the other party's uuid on the person's leg in the registry (`consultHeld`), plays the other party the tenant's hold music (S9-19, G-125: `uuid_transfer <leg> endless_playback:${hold_music} inline`, with `hold_music` set to the neutral tone first when the dialplan did not export one), schedules its ring-back on the node (`sched_api +300 cuc-ringback-<leg> uuid_transfer <leg> <person's extension> XML public`, after `uuid_setvar_multi` sets the internal-call headers: after 5 minutes it rings the person who put it on hold, with its own caller ID, rather than being dropped; the node's scheduler does this even if call-control is down), and sends the person's leg through the dialplan; complete is `uuid_bridge <waiting> <answered>`, `sched_del cuc-ringback-<waiting>` and `uuid_kill` of the person's leg, cancel is `uuid_bridge <person> <waiting>` and the same `sched_del`.

Each operation is audited (`call.hangup`, `call.transfer`, `call.park`, `call.pickup`, `call.dial`, `call.transfer.consult|complete|cancel`; `reason` names the number or the slot) before the call is touched, and nothing is done when the audit cannot be written. Answers: 404 `call_not_found`, `no_linked_extension`, `parking_lot_not_found`; 400 `invalid_destination`; 409 `call_not_answered`, `call_not_connected`, `call_not_ringing`, `own_call`, `parking_lot_full`, `parking_lot_elsewhere`, `transfer_in_progress`, `no_transfer_in_progress`, `consult_not_answered`, `phone_unreachable`, `phone_not_answered`; 403 `people_only` and the guard's; 503 `call_control_unavailable`, `media_unavailable` (nothing was done), `media_node_failed`.

**Pickup groups (S9-18, G-125).** `GET /v1/tenants/{t}/me/pickup` (`self.calls`) lists the calls ringing a phone within the person's pickup groups (pbx-config-service's `GET /internal/v1/tenants/{t}/extensions/by-number/{n}/pickup-peers`: every other member of their groups, by number), oldest first; `POST .../me/pickup` `{callUuid?}` takes the one named, or the oldest, exactly as the console's pickup does (their own phone rings into `&intercept(<caller's leg>)`, audited `call.pickup`); 404 `nothing_to_pick_up`, `call_not_found` for a call outside their groups. For `*8`, `GET /internal/v1/tenants/{t}/pickup-target/{extension}` (service token) names the caller's leg and its node; telephony-config's dialplan answers the `*8` call and intercepts that leg, on the node that holds it only (confirmed live: an unanswered channel gets early media and no 200 OK from `intercept`).

**Queues and agents, live (S9-13, G-126).** `mod_callcenter` keeps queues and agents in each node's memory, so call-control asks every node in service and merges the answers: `callcenter_config queue list`, then for each of the tenant's queues (`<queue id>@<tenant domain>`) `queue list members` (waiting: `Waiting` or `Trying`; answered: `Answered`; the oldest `joined_epoch`) and `queue list agents` (by the queue's tiers). An agent seen on several nodes counts as it is where its status changed last. A queue appears once a node has loaded it, which a call does (G-47). `GET /internal/v1/tenants/{t}/queues` (service token) answers `{queues:[{queueId, waiting, longestWaitingSince, answered, callsAnswered, callsAbandoned, agents:[{extension, status: available|on_break|logged_out|other, activity: waiting|ringing|on_call|idle, callsAnswered, statusSince}]}]}`.

| Route | Permission | Class | What |
|---|---|---|---|
| `GET /v1/tenants/{t}/me/agent-status` | `self.settings` | config | the person's own status as an agent and the queues they answer; 404 `not_an_agent`, `no_linked_extension` |
| `PUT /v1/tenants/{t}/me/agent-status` `{status: available\|on_break\|logged_out}` | `self.settings` | config | sign themselves in, out or on a break, as `*45`/`*46` do |
| `GET /v1/tenants/{t}/me/queues` | `self.settings` | config | S9-20 (G-126): the queues the person answers as an agent, `{queues:[{queueId, label, waiting, longestWaitingSince}]}`, counts only; a queue no node has loaded shows nobody waiting; empty for someone who is no agent. Labels come from pbx-config-service's by-number lookup (`agentQueues`) |
| `PUT /v1/tenants/{t}/live-agents/{extension}/status` (same body) | `queue.agent.manage` | config | S9-20 (G-126): a supervisor, administrator or queue lead does it for an agent. Checked against the agent's queues (`scopedPermission`): held across the tenant it covers every agent; granted on `queue:Q1` it covers the agents who answer Q1 (one status per agent, so a grant on any of their queues is enough). 403 `insufficient_permission` before anything is audited; 503 `permissions_unavailable` |

The status is set on **every** node in service the way `agent_status.lua` sets it on one: `callcenter_config agent add '<ext>@<domain>' 'callback'`, `agent set contact` (through OpenSIPs), `agent set status`, so a queue call reaches the agent whichever node holds the queue. Audited (`queue.agent.status_changed`, `extension:<number>`, the status in `reason`) before anything is set; nothing is set when the audit cannot be written. Answers 503 `media_unavailable` when no node can be reached, `media_node_failed` when none took it.

## cdr-service

**Owns:** CDRs, ingestion dedupe, webhook subscriptions.

**Public API:** `GET /v1/tenants/{t}/cdrs` (private data, `cdr.read`; filters for period, direction, number, DID; cursor paging), `GET .../cdrs/{id}`, `POST|GET .../cdr-exports` (`cdr.export`), `GET .../billing-records`. The console has a Call records screen for the first three (G-106).

**Ingest:**

- `POST /ingest/json-cdr` from FS `mod_json_cdr` (shared-token auth; FS retries and falls back to disk; dedupe on `(call_uuid, node)`)
- Consumes `call.lost` to create synthetic CDRs flagged `disposition=node_failure`

**CDR schema v1** (proposal answering SAD §12; frozen in S2-18 — `services/cdr-service/src/schema.ts`):

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | CDR ID |
| `callId` | uuid | Correlates legs; FS `call_uuid` of the A-leg |
| `tenantId`, `resellerId` | uuid | |
| `direction` | enum | `inbound`, `outbound`, `internal` |
| `startAt`, `answerAt`, `endAt` | RFC 3339 | UTC |
| `durationSec`, `billableSec` | int | `billableSec` = answered time |
| `from`, `fromName`, `to`, `dialed` | string | E.164 where applicable |
| `did` | string? | For inbound calls |
| `trunkId` | uuid? | For external legs |
| `extensionIds` | uuid[] | Extensions involved |
| `disposition` | enum | `answered`, `no_answer`, `busy`, `failed`, `cancelled`, `node_failure` |
| `hangupCause` | string | Q.850 name |
| `hangupBy` | enum | `caller`, `callee`, `system` |
| `queueId`, `flowId` | uuid? | |
| `recordingIds` | uuid[] | Tenant-only field (private) |
| `legs` | object[] | Per-leg detail (tenant-only) |
| `sip` | object | Codec, MOS estimate, user agent (tenant-only) |

**Public API:**

- `GET /v1/tenants/{t}/cdrs?from&to&cursor&limit&direction&extension&did`
- `GET /v1/tenants/{t}/cdrs/{id}`
- `POST /v1/tenants/{t}/cdr-exports` (async CSV to S3)
- Webhooks: `cdr.created`, signed with HMAC-SHA256 and retried with backoff

The **billing view** for resellers is pending decision D-013.

## recording-service

**Owns:** recording policies, recording metadata, retention policies.

**Public API:**

- `/v1/tenants/{t}/recording-policies` (tenant default, plus overrides per extension, agent, queue, or DID, by direction; an `agent` rule, S5-14, is decided when the agent answers a queue call; `allowOnDemand`, S5-13, arms the in-call feature codes)
- `/v1/tenants/{t}/recordings` (search)
- `GET /v1/tenants/{t}/recordings/{id}:url`, which returns a presigned URL after an authorization check and writes an audit entry
- `DELETE` (requires permission; audited)
- `/v1/tenants/{t}/recording-settings`: retention days and "recording required" (`failClosed`, S5-12). Each change emits `recording.settings.updated`, which telephony-config copies so it can refuse calls while this service is down.

**Internal:**

- `POST /internal/v1/recordings:evaluate`, with call context in and the decision (plus consent-announcement asset) out. telephony-config caches the result.
- `GET /internal/v1/recordings/fail-closed-tenants`, the tenants that require recording, for telephony-config's reconciliation (S5-12)
- `POST /internal/v1/recordings/control`, a feature code pressed during a call (`*1` on demand, `*2` pause), relayed by telephony-config from the node: decides with the call's rules, records the change and its audit event in one transaction, then answers (S5-13). S5-15: also takes an explicit `action` (`start`, `stop`, `pause`, `resume`) instead of a toggling `code`, and an `actor` (with `ip` and `requestId`), from call-control for the console's buttons: the same rules, but a Start while a recording runs (`already_recording`), a Pause while paused (`already_paused`) or a Resume while not (`not_paused`) is refused rather than undoing someone else's action, checked under the row lock; the audit event names the person (actor type `user`)
- `POST /internal/v1/recordings:upload-url`, used by the node uploader
- `POST /internal/v1/recordings/{id}:complete`

## voicemail-service

**Owns:** mailboxes, greetings, messages, transcription jobs.

**Internal API (for the FS Lua voicemail app):**

- Mailbox lookup and PIN check
- Create a new message (a `pending` row that names its spool file, `vm-{id}.wav`)
- List, mark-read, and delete messages

**Internal API (for the node uploader, S5-16):** `POST /internal/v1/voicemail/messages/{id}/upload-url`, `.../complete` (verifies the stored object's size and MD5 before the message becomes ready) and `.../fail`, the same contract as recording-service's, addressed by message id alone. The Lua app records into the node spool and never uploads.
- Greeting URLs

**Public API:** mailbox settings, messages (listen via presigned URL, delete), greeting upload, and `PUT /v1/tenants/{t}/voicemail/mailboxes/{id}/email-settings` (`voicemail.access`, private data: notification address, attach audio, keep / mark read / delete after emailing; G-107).

**Internal API additions (G-107):** the mailbox response carries the email settings and `unreadCount`; the message response carries caller ID, duration and size; `GET .../messages/{id}/audio` returns the bytes through this service's own storage access, so notification-service holds no bucket credentials.

**Integrations:**

- On `complete` (the uploader's, once the audio is verified in storage), emits `voicemail.message.created` (thin: ids only). notification-service reads the settings, message details and audio through the internal API and sends voicemail-to-email using a brand-aware template (built, G-107).
- MWI is to be sent through the OpenSIPs presence `message-summary` PUBLISH; not wired yet (G-42, G-108).
- Transcription uses a `TranscriptionProvider` interface with one adapter per vendor (O-3). It is off by default and enabled per tenant or mailbox.

## notification-service

**Owns:** email templates and outbound email delivery (SMTP relay). It's the only component that sends email.

Templates are brand-aware: the renderer receives a resolved brand, or NEUTRAL. Templates: voicemail, fax received, password reset, invitation, recording-export-ready, and system alerts to reseller support contacts.

**Consumes:** the events listed in [05 §5](05-data-architecture.md#5-events).

**Calls:** org-service for the brand of each email; identity-service to issue the one-time token of a password-reset or invitation link, just before sending it (G-55). When identity-service refuses (`404`/`409`: the reset or invitation is gone, used or expired, or the user was disabled since), the event is consumed and no email is sent. A retried send asks again and emails the fresh link. The token is never logged or stored.

## chat-service

**Owns:** the XMPP server deployment and the adapter layer. The XMPP server is O-4 (ejabberd recommended).

- Creates one vhost per tenant domain on `org.tenant.created`.
- Authenticates XMPP logins against identity-service, either through external auth or by issuing tokens, depending on the server.
- Syncs rosters and default group rooms from identity users and optional departments.
- Configures per-tenant message archive (MAM) retention.
- Chat content is tenant-private: resellers get no access.

## fax-service (Stage 7)

Inbound: a fax DID routes to FS `rxfax` (T.38 via `mod_spandsp`), then the file is uploaded to the tenant bucket, converted to PDF, emailed, and listed in the console.

Outbound: an API or console upload is converted to TIFF-F, then call-control originates `txfax` over the tenant trunk. The TSI and header text come from the tenant; they are never platform-branded.

## sms-service (Stage 7)

SMS on BYO carriers depends on each carrier's messaging API rather than SIP. The service defines a `CarrierMessagingAdapter` interface (send, inbound webhook verification, delivery receipts) with adapters per carrier (O-8). Inbound messages are routed per DID to a user (delivered via XMPP and the console), an email address, or a webhook. Message content is tenant-private.

## analytics-service (Stage 7)

Consumes CDR and call/queue events to build aggregate tables: calls per hour, answer rate, service level, abandon rate, and agent occupancy. Serves dashboards and real-time wallboards (through the api-gateway WebSocket).

Tenant-level analytics are private. Resellers get only aggregate usage metrics (counts and minutes per tenant), subject to D-013.

## provisioning-service (Stage 8)

**Not built as a separate service.** Yealink auto-provisioning is currently served by pbx-config-service (see its section above); this service is the planned home for multi-vendor provisioning.

Serves per-MAC configuration for Yealink, Polycom, Snom, and Grandstream over HTTPS. A phone authenticates with HTTP Basic, using either its own per-device credential or a platform-wide credential (G-103 records the trade-off). Templates are brand-neutral, with reseller branding optional (for example, a phone display logo).
