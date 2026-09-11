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

**Must not** contain business logic or authorization decisions beyond authentication and coarse route-level checks. Services authorize.

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
- `GET /v1/public/brand?host=` (unauthenticated; returns reseller brand or `{"neutral": true}`)

**Events:** `org.reseller.created|updated|suspended|resumed|deleted`, `org.tenant.*` (same verbs), `org.domain.added|removed`, `org.brand.updated`.

**Depends on:** identity-service (creating the initial admin user for a new reseller or tenant), storage (brand assets).

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

**Events:** `identity.user.created|updated|disabled|deleted`, `identity.user.password_reset_requested`, `identity.grant.changed`.

## pbx-config-service

**Owns:** extensions, SIP credentials, devices, DIDs, ring and hunt groups, queues and agents, parking lots, conference rooms, schedules, media assets, emergency locations.

**Public API:** `/v1/tenants/{t}/extensions`, `/dids`, `/ring-groups`, `/queues`, `/parking-lots`, `/conference-rooms`, `/schedules`, `/media-assets` (upload via presigned URL, then `:finalize`, which transcodes to 8 kHz/16 kHz WAV).

**Events:** `pbx.{entity}.created|updated|deleted` for each entity above.

**Notes:**

- On create, generates a SIP password (never returned after creation except through a `:reveal` action that requires a permission and is audited) and computes HA1 for the tenant realm.
- Validates extension numbering against the tenant's dial plan (no collisions with feature codes, parking slots, conference numbers, or queue numbers).

## telephony-config

**Owns:** the read model of everything FreeSWITCH and OpenSIPs need, the `opensips` schema projection, and the xml_curl endpoints.

**Interfaces:**

- `POST /fs/directory`, `/fs/dialplan`, `/fs/configuration`, reachable only from FS nodes (network ACL + shared token). See [03 §3.1](03-signaling-and-media.md#31-xml_curl-endpoints-telephony-config).
- OpenSIPs projection: `domain`, `subscriber`, `address`, `dr_gateways`, `dr_rules`, `dr_groups`, `registrant`, `dispatcher`, plus MI reload calls.

**Consumes:** see [05 §5](05-data-architecture.md#5-events).

**Invariant:** after any config event, the projection and cache purge MUST complete within 5 s (p95). A reconciliation job compares the read model with the source services every 15 min and repairs drift.

## trunk-service

**Owns:** tenant trunks, trunk IPs, outbound routes, emergency routes. Credentials use envelope encryption through `@cuc/crypto`.

**Public API:** `/v1/tenants/{t}/trunks`, `/outbound-routes`, `/emergency-routes`, and `/v1/tenants/{t}/trunks/{id}:status`, which returns registration state (read from OpenSIPs via telephony-config's internal API).

Resellers configure trunks for their tenants. Tenant admins can view trunks and, with the `trunk.manage` grant, edit them.

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
- `GET /internal/v1/tenants/{t}/calls` (live calls from Redis)
- `POST /internal/v1/nodes/{id}:drain`

**Emits:** `call.channel.created|answered|bridged|held|hungup`, `call.lost`, `call.queue.*` (from `mod_callcenter` events), `call.conference.*`, `call.park.*`. Events are rate-shaped per tenant.

**Monitoring:** `mode=listen` originates a call to the supervisor's own SIP device on the node that owns the target call, then runs `eavesdrop(targetUuid)`. `whisper` sets `eavesdrop_whisper_aleg` or `_bleg`. `barge` uses `three_way`. Browser-based listening would need WebRTC, which is out of scope (O-14).

## cdr-service

**Owns:** CDRs, ingestion dedupe, webhook subscriptions.

**Ingest:**

- `POST /ingest/json-cdr` from FS `mod_json_cdr` (shared-token auth; FS retries and falls back to disk; dedupe on `(call_uuid, node)`)
- Consumes `call.lost` to create synthetic CDRs flagged `disposition=node_failure`

**CDR schema v1** (proposal answering SAD §12; to be frozen in S2-11):

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
- Upload URL for a new message, then `:complete`
- List, mark-read, and delete messages
- Greeting URLs

**Public API:** mailbox settings, messages (listen via presigned URL, delete), greeting upload.

**Integrations:**

- On `:complete`, emits `voicemail.message.created`. notification-service sends voicemail-to-email with the audio attached, using a brand-aware template.
- MWI is sent through the OpenSIPs presence `message-summary` PUBLISH.
- Transcription uses a `TranscriptionProvider` interface with one adapter per vendor (O-3). It is off by default and enabled per tenant or mailbox.

## notification-service

**Owns:** email templates and outbound email delivery (SMTP relay). It's the only component that sends email.

Templates are brand-aware: the renderer receives a resolved brand, or NEUTRAL. Templates: voicemail, fax received, password reset, invitation, recording-export-ready, and system alerts to reseller support contacts.

**Consumes:** the events listed in [05 §5](05-data-architecture.md#5-events).

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

Serves per-MAC configuration for Yealink, Polycom, Snom, and Grandstream over HTTPS with per-device credentials. Templates are brand-neutral, with reseller branding optional (for example, a phone display logo).
