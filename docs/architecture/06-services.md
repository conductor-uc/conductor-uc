# 06 — Service catalog

This refines SAD §7. It adds five services the SAD implies but does not name: **api-gateway**, **pbx-config-service**, **telephony-config**, **call-control**, and **notification-service**. Each has a clear home it would otherwise lack:

- Extensions, DIDs, groups, and queues belong to neither org-service nor callflow-service, so they get pbx-config-service.
- FreeSWITCH and OpenSIPs integration needs one owner, so it gets telephony-config and call-control.
- Brand-aware email is used by voicemail, fax, and identity, so it gets notification-service.

Every service:

- is a Node.js 22 LTS / TypeScript service on Fastify, bootstrapped with `@cuc/http`
- exposes `GET /healthz` (liveness) and `GET /readyz` (dependencies)
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

- Verifies JWTs locally (JWKS from identity-service) and API keys (by calling identity-service, cached).
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

Responses carry `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy` and `Permissions-Policy`; API responses are `Cache-Control: no-store`. Route table entries added for certificates and provisioning: `/v1/platform/acme-settings`, `/v1/platform/certificates` (org), `/v1/public/provision`, `/v1/tenants/*/devices`, `/v1/tenants/*/sip-endpoint` (pbx).

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
| `tenant:{t}:presence` | `monitor.presence` | config | `{extensions:[{extension, state}]}` (non-idle only) → `presence.changed {extension, state}`; state `ringing`, `on_call` or `idle` |
| `tenant:{t}:queues` | `queue.read` | config | none yet → reserved for queue and agent state (wallboards, S7-06); nothing publishes to it yet |

A `LiveCall` is one channel (leg): `callUuid`, `direction` (`inbound`: the leg called in to the media node; `outbound`: the node placed it), `state` (`ringing`, `answered`, `held`), `from`, `to`, `startedAt`, `answeredAt`, `bridgedTo` (the other leg), `recording` (`on`, `off`; `paused` is reserved for S5-13). The media node is not sent. Record, stop and pause buttons (S5-15) read `recording` and act by `callUuid`.

**Authorization.** On subscribe, and again every `REALTIME_PERMISSION_RECHECK_MS`: org ancestry with H2 (a tenant's people reach only their tenant; a reseller its own tenants, asked of org-service's `/internal/v1/orgs/{id}/lineage` and cached; the master any tenant), then H1 (a reseller never gets a private topic), then the topic's permission through identity-service's `/internal/v1/orgs/{org}/users/{user}/permissions` (`@cuc/http`'s `createRemotePermissionResolver`, cached `REALTIME_PERMISSION_CACHE_TTL_MS`). A lookup that fails refuses (`unavailable`). A revoked permission ends the subscription within the recheck interval plus the cache TTL. Every subscription to a private topic is audited (`audit.event.recorded`, action `realtime.calls.subscribed`, published directly as other reads are); if it cannot be audited it is refused.

**Events.** The hub reads the `CALL` stream (`call.>`) with an ordered consumer: ephemeral, owned by the gateway process, starting at new messages. Each event is routed by `orgContext.tenantId` to that tenant's topics and sent only to their subscribers; an event with no tenant goes nowhere. A `calls` subscription starts with call-control's `GET /internal/v1/tenants/{t}/calls`, and events arriving meanwhile wait until the snapshot is sent. Presence is derived from the same calls (see below). If the feed stops, every subscription is ended with `unavailable` and clients subscribe again when it is back.

**Presence, as built.** No service can read extension state yet: registrations (`usrloc`) and BLF dialog state (`presence`, S2-17) live in OpenSIPs' own tables, and do-not-disturb in call handling. So presence is derived from live calls: a leg's extension is its caller for an inbound leg and its callee for an outbound one, when that number has an extension's shape (2 to 6 digits), so an outside number never appears. `idle` means "on no call we can see", not "registered". Registration, DND and offline states are G-119.

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
- `/v1/orgs/{orgId}/roles`, `/v1/orgs/{orgId}/grants`, `/v1/orgs/{orgId}/api-keys`
- `GET /v1/orgs/{orgId}/audit-events`
- `GET /.well-known/jwks.json`

**Internal:** `POST /internal/v1/authz/check` (batch). Services normally evaluate authorization with the `@cuc/authz` library against the token's claims plus a cached grant set, and call this endpoint only for fine-grained grants that aren't in the token.

**Reset and invitation links (G-55):** `POST /internal/v1/orgs/{orgId}/password-resets/{resetId}/link` and `POST /internal/v1/orgs/{orgId}/invitations/{invitationId}/link`, called by notification-service with the service token when it sends the email. A reset request or invitation is created without a token; this call creates one, stores its SHA-256 in place of any earlier one (so the link of an email that was retried stops working) and returns the raw token once, with the request's own expiry: `200 {token, expiresAt}`. `404` when there is no such reset or invitation in that org; `409` `link_used`, `link_expired` or `user_inactive`. No event, outbox row or backup holds a usable token.

**Events:** `identity.user.created|updated|disabled|deleted`, `identity.user.password_reset_requested`, `identity.invitation.created`, `identity.user.mfa_reset`, `identity.grant.changed`. The reset and invitation events carry ids only (version 2, G-55).


## pbx-config-service

**Owns:** extensions, SIP credentials, devices, DIDs, ring and hunt groups, queues and agents, parking lots, conference rooms, schedules, media assets, emergency locations.

**Public API:** `/v1/tenants/{t}/extensions`, `/devices`, `/sip-endpoint`, `/dids`, `/ring-groups`, `/queues`, `/parking-lots`, `/conference-rooms`, `/schedules`, `/media-assets` (upload via presigned URL, then `:finalize`, which transcodes to 8 kHz/16 kHz WAV; `/{id}/download-url` plays a ready one back, G-80).

**Events:** `pbx.{entity}.created|updated|deleted` for each entity above.

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
- OpenSIPs projection: `domain`, `subscriber`, `address`, `dr_gateways`, `dr_rules`, `dr_groups`, `registrant`, `dispatcher`, `tls_mgm`, plus MI reload calls.
- **Certificates:** `certificate-sync` consumes `org.certificate.issued` and runs a periodic reconcile. Each active SIP proxy certificate becomes a `tls_mgm` server row named for its hostname; the platform's own is also the `default` row. It then calls `tls_reload`. Needs `ORG_SERVICE_URL` and `INTERNAL_SERVICE_TOKEN` to fetch the material. See [03 §2.3](03-signaling-and-media.md#23-sip-over-tls).

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

- `/v1/tenants/{t}/flows` (CRUD)
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

- `POST /internal/v1/calls/{uuid}:eavesdrop` with `{mode: listen|whisper|barge, supervisorExtensionId}`
- `:hangup`, `:transfer`
- `POST /internal/v1/originate`
- `GET /internal/v1/tenants/{t}/calls` (live calls from Redis, one entry per leg; built in S5-08 for api-gateway's realtime hub)
- `POST /internal/v1/nodes/{id}:drain`

**Emits:** `call.channel.created|identified|answered|bridged|held|unheld|recording_started|recording_stopped|hungup`, with the tenant in `orgContext` whenever it is known. A call from a trunk has no tenant at `created` and learns it from `cuc_tenant_id` (which the dialplan exports to every leg it bridges to) on its later events; a leg that never names its tenant takes the tenant of the leg bridged to it. The first time a channel's tenant becomes known after `created`, `call.channel.identified` carries the whole call as it stands, before the event that named the tenant, so a live view that routes by tenant sees the call start before it changes. Each node's ESL events are handled one at a time in the order FreeSWITCH raised them, and outbox ids are UUIDv7 increasing within a process, so the bus carries a call's events in order. Also `call.lost`, `call.queue.*` (from `mod_callcenter` events), `call.conference.*`, `call.park.*`. Events are rate-shaped per tenant.

**Monitoring:** `mode=listen` originates a call to the supervisor's own SIP device on the node that owns the target call, then runs `eavesdrop(targetUuid)`. `whisper` sets `eavesdrop_whisper_aleg` or `_bleg`. `barge` uses `three_way`. Browser-based listening would need WebRTC, which is out of scope (O-14).

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

- `/v1/tenants/{t}/recording-policies` (tenant default, plus overrides per extension, agent, queue, or DID, by direction)
- `/v1/tenants/{t}/recordings` (search)
- `GET /v1/tenants/{t}/recordings/{id}:url`, which returns a presigned URL after an authorization check and writes an audit entry
- `DELETE` (requires permission; audited)

**Internal:**

- `POST /internal/v1/recordings:evaluate`, with call context in and the decision (plus consent-announcement asset) out. telephony-config caches the result.
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
