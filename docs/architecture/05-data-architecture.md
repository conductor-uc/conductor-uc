# 05 — Data architecture

## 1. Stores

| Store | Purpose | System of record? |
|---|---|---|
| MariaDB 11.4 LTS | All configuration, identity, CDR, and metadata | Yes |
| S3-compatible storage | Recordings, voicemail audio, media assets (prompts/MOH/greetings), fax documents, brand assets, exports | Yes (binary data) |
| Redis (Sentinel) | Node liveness, call ownership, affinity leases, rate limits, short-lived caches | **No** |
| NATS JetStream | Domain events between services | No (a transport; each service persists what it needs) |

### 1.1 Database-per-service (D-005)

There is one MariaDB cluster, with **one schema (database) per service** and one DB user per service that has grants only on its own schema.

- No cross-schema joins and no cross-service foreign keys. References to another service's entities are stored as IDs, and consistency comes from events.
- A service that needs another service's data (for example, `telephony-config` needing extensions and trunks) either keeps a **local read model** built from events, or calls the owner's internal API. `telephony-config` keeps a read model because it's on the call-setup hot path.
- The `opensips` schema is written only by `telephony-config` and read by OpenSIPs.

### 1.2 IDs and time

- Primary keys are UUIDv7 (time-ordered), generated in the application and stored in MariaDB's `UUID` column type.
- Public, human-friendly identifiers (tenant slug, extension number) are separate unique columns, never PKs.
- All timestamps are `DATETIME(3)` in UTC. Tenant time zones are stored as IANA names on the tenant and applied only at presentation and in schedule evaluation.
- Every mutable row has `created_at`, `updated_at`, and `version` (an integer for optimistic concurrency). Soft deletion (`deleted_at`) is used only where history matters.

## 2. Tenant scoping

MariaDB has no row-level security, so isolation is enforced in code with defense in depth:

1. Every tenant-owned table has a non-null `tenant_id` and a composite index that leads with `tenant_id`.
2. Services access data only through `@cuc/db`'s `scoped(ctx)` helper. It returns a query builder that injects `WHERE tenant_id = :ctxTenant` into every select, update, and delete, and sets `tenant_id` on every insert. Raw queries are allowed only in migrations and are banned elsewhere by lint rule.
3. For queries that span tenants (master or reseller dashboards, background jobs), a separate `unscoped(ctx, reason)` helper requires an explicit reason string and is audited.
4. Every repository test suite includes a **cross-tenant probe**: create data in tenant A, then query as tenant B and expect it to be absent.
5. Reseller-level queries scope by `reseller_id`. Tables that resellers read (for example, tenant summaries) also carry `reseller_id`, denormalized at creation (tenants cannot be re-parented in v1).

## 3. Core schemas (initial)

These are summaries, not DDL. Migrations live in each service (`services/<svc>/migrations`).

### 3.1 org-service

| Table | Key columns |
|---|---|
| `orgs` | `id`, `type` (`master`/`reseller`/`tenant`), `parent_id`, `reseller_id` (null for master/reseller), `slug`, `name`, `status`, `timezone`, `country`, `limits` (JSON: max extensions, channels, and so on) |
| `reseller_base_domains` | `id`, `reseller_id`, `fqdn`, `verification_token`, `verified_at`, `status` |
| `tenant_domains` | `id`, `tenant_id`, `fqdn` (unique), `is_primary` |
| `brands` | `reseller_id` (PK), fields per [02 §5.4](02-tenancy-and-branding.md#54-reseller-brand-fields), asset IDs |
| `console_hostnames` | `fqdn` (PK), `reseller_id`, `tls_status` |
| `tls_certificates` | `fqdn` (PK), `purpose` (console or SIP proxy), `reseller_id`, `status`, `certificate_pem`, `private_key_enc` (envelope-encrypted), `not_before`, `not_after`, `attempts`, `next_attempt_at`, `last_error`, `version` |
| `acme_challenges` | `token` (PK), `fqdn`, `key_authorization`, `expires_at` (HTTP-01 answers) |
| `acme_settings` | One row: `contact_email`, `directory` (production/staging), terms agreement (`terms_agreed_directory`, `terms_agreed_at`, `terms_agreed_by`, `terms_url`) |
| `acme_accounts` | The ACME account per directory: `account_key_enc` (encrypted), `account_url` |
| `outbox` | Standard outbox (see §5) |

Constraint: a DB check constraint plus a service invariant guarantee that `type=tenant` implies the parent is a reseller, and `type=reseller` implies the parent is the master. A unique partial index guarantees a single master.

### 3.2 identity-service

| Table | Key columns |
|---|---|
| `users` | `id`, `org_id`, `email` (unique per org), `display_name`, `password_hash` (argon2id), `status`, `mfa_enrolled`, `last_login_at` |
| `mfa_factors` | `id`, `user_id`, `type` (`totp`/`webauthn`), `secret_enc` |
| `sessions` | `id`, `user_id`, `refresh_hash`, `family_id`, `expires_at`, `revoked_at`, `ip`, `ua` |
| `roles` | `id`, `org_id` (null for built-in), `name`, `built_in` |
| `role_permissions` | `role_id`, `permission` |
| `role_assignments` | `user_id`, `role_id`, `scope_org_id` |
| `grants` | `id`, `org_id`, `principal_type` (`user`/`role`), `principal_id`, `permission`, `scope_type`, `scope_id` (see [07 §3](07-security-and-permissions.md#3-authorization)) |
| `api_keys` | `id`, `org_id`, `name`, `prefix`, `hash`, `permissions` (JSON), `expires_at`, `last_used_at` |
| `audit_events` | `id`, `at`, `actor_type`, `actor_id`, `actor_org_id`, `target_org_id`, `action`, `resource`, `data_class`, `reason`, `ip`, `request_id` (append-only, partitioned by month) |

### 3.3 pbx-config

| Table | Key columns |
|---|---|
| `extensions` | `id`, `tenant_id`, `number`, `user_id` (nullable), `display_name`, `caller_id_name`/`number`, `voicemail_enabled`, `forwarding` (JSON), `dnd`, `max_concurrent`, `emergency_location_id` |
| `sip_credentials` | `id`, `tenant_id`, `extension_id`, `username`, `secret_enc` (envelope-encrypted), `ha1`, `ha1b`, `realm` |
| `devices` | `id`, `tenant_id`, `extension_id`, `mac`, `vendor`, `model` (for Stage 8) |
| `dids` | `id`, `tenant_id`, `e164` (globally unique), `trunk_id`, `destination_type`, `destination_id`, `sms_enabled`, `fax_enabled` |
| `ring_groups` | `id`, `tenant_id`, `label`, `strategy` (`simultaneous`/`sequential`/`round_robin`/`random`, S2-08), `member_extension_ids` (JSON array, in ring order — no separate members table, same "ordered list as JSON" choice `outbound_routes.trunk_ids` already made), `ring_timeout_seconds`, `no_answer_destination_type`/`_id` (same `DestinationType` union `dids` uses; only `extension` resolves to a real fallback bridge today, G-25) |
| `queues` / `queue_agents` / `queue_tiers` | Maps to `mod_callcenter` concepts; `strategy`, `moh_asset_id`, `max_wait`, `announce` |
| `parking_lots` | `id`, `tenant_id`, `slot_start`, `slot_end`, `timeout`, `return_dest` |
| `conference_rooms` | `id`, `tenant_id`, `number`, `pin_enc`, `video` (bool), `layout`, `max_members` |
| `schedules` | `id`, `tenant_id`, `timezone`, `rules` (JSON), `holidays` (JSON) |
| `media_assets` | `id`, `tenant_id`, `kind` (`prompt`/`moh`/`greeting`), `status` (`pending`/`processing`/`ready`/`failed`, S2-07), `content_type`, `object_key` (the raw upload), `variant_8k_key`/`variant_16k_key` (transcoded, null until `ready`), `duration_ms`, `sha256` |
| `emergency_locations` | Depends on G-1 |

### 3.4 trunk-service

| Table | Key columns |
|---|---|
| `trunks` | `id`, `tenant_id`, `reseller_id`, `name`, `auth_mode` (`register`/`ip`/`both`), `host`, `port`, `transport`, `username`, `secret_enc`, `from_domain`, `codecs`, `max_channels`, `caller_id_policy`, `status` |
| `trunk_ips` | `trunk_id`, `cidr` (inbound identification) |
| `outbound_routes` | `id`, `tenant_id`, `priority`, `pattern` (prefix or regex), `trunk_ids` (ordered), `strip`, `prepend` |
| `emergency_routes` | `tenant_id`, `trunk_id`, `numbers` |

### 3.5 callflow-service (S2-09)

`flows` (`id`, `tenant_id`, `name`, `draft_graph` JSON — the one mutable working copy, `draft_updated_at`, `current_published_version_id` nullable). `flow_versions` (`id`, `tenant_id`, `flow_id`, `version_number` monotonic per flow and never reused (even across rollback), `graph` JSON, `ir` JSON — the compiled form S2-10's flow_runner actually fetches, `published_at`). A version row is only ever inserted, never updated or deleted — immutability holds by construction, not convention.

Two deviations from this section's original sketch, made while implementing S2-09: no separate `status` (`draft`/`published`/`archived`) on `flow_versions` — every row in that table is by definition an immutable published version, and the one mutable draft lives directly on `flows` instead, so there is nothing else a version's status could be. And no separate `entry_points` table — `@cuc/callflow-ir`'s graph schema carries `entryPoints` (a name → node id map) inline, so a flow can expose several named entry points (e.g. `main`, `after_hours`) without a second table; a DID or extension still just stores a `flowId` (S2-03/S1-09's own destination-type columns), not a flow+entry-point pair, so `main` is the effective default entry point until a caller resolves otherwise.

`callflow` is its own event domain (§5). `callflow.flow.published` fires on both `:publish` and `:rollback` — both change which version is *current*, which is all a consumer (flow_runner's IR cache, eventually) needs to know.

### 3.6 cdr-service

`cdrs` (range-partitioned by month on `start_at`, indexed by `(tenant_id, start_at)`). Columns follow the CDR v1 schema ([06 §cdr-service](06-services.md#cdr-service)). Also `cdr_legs`, `ingest_dedupe` (`call_uuid`, `node_id`), `webhook_subscriptions`, and `webhook_deliveries`.

### 3.7 media-worker (S2-07)

No business tables of its own — `outbox`/`consumed_events` only, the same `@cuc/events` schema every service carries. It exists purely to isolate one operation: transcoding a tenant's raw, untrusted media upload with `ffmpeg`, kept out of pbx-config-service's own process/image (which owns `media_assets` above and holds tenant secrets) so a hostile upload's blast radius is contained to a service with no database of its own to reach. Consumes `pbx.media_asset.finalize_requested`, fetches the raw upload and writes the two transcoded WAV variants directly via `@cuc/storage`'s `getObject`/`putObject` (§4 below), and reports back to pbx-config-service over its internal API rather than through its own outbox — see `services/media-worker/src/consumers/media-asset.consumer.ts`'s own doc comment for the full reasoning.

### 3.8 call-control (S2-11)

No business tables of its own either — `outbox`/`consumed_events` only. Call ownership is not relational: it lives entirely in Redis (04 §3), which is explicitly not a system of record (04 §1, §5). This service's MariaDB schema exists solely so the `outbox` relay has somewhere durable to write `call.channel.*` (§5 below) — the durable trail cdr-service (S2-18) and future queue/park/conference consumers build on, when the live-only Redis view is not enough.

### 3.9 voicemail-service (S2-16)

`mailboxes` (`id`, `tenant_id`, `extension_id`, `pin_enc` — envelope-encrypted, same `@cuc/crypto` pattern as SIP credentials — `greeting_status`, `greeting_object_key`), `messages` (`id`, `tenant_id`, `mailbox_id`, `status` `pending`/`ready`/`failed`, `object_key`, `caller_id_name`, `caller_id_number`, `duration_ms`, `size_bytes`, `is_read`). No transcode step (unlike media-worker): the Lua voicemail app records directly to a playable WAV, so this service only ever presigns uploads and records the result. Its own internal API is what telephony-config's `/fs/voicemail/...` routes proxy for the FS Lua app (`telephony/freeswitch/scripts/voicemail.lua`) — CLAUDE.md rule 4 means the Lua app never calls this service directly. Emits `voicemail.message.created` and `voicemail.mailbox.mwi_changed` (the latter currently has no consumer — docs/decisions.md G-42).

## 4. Object storage layout (D-011, O-9)

Default: **one bucket per tenant**, as the SAD specifies. It sits behind a `@cuc/storage` abstraction that also supports a **prefix-per-tenant** mode, because some S3-compatible providers cap the number of buckets per account.

```
bucket: {STORAGE_BUCKET_PREFIX}-t-{tenantShortId}      (per-tenant mode)
  recordings/{yyyy}/{mm}/{dd}/{callUuid}/{legOrMixed}.{opus|wav}
  voicemail/{mailboxId}/{messageId}.wav
  voicemail/{mailboxId}/greeting.wav
  media-assets/{assetId}/raw                             (S2-07: the tenant's own upload, whatever format they sent)
  media-assets/{assetId}/8k.wav                          (S2-07: transcoded, mono, for narrowband playback)
  media-assets/{assetId}/16k.wav                         (S2-07: transcoded, mono, for wideband playback)
  fax/{yyyy}/{mm}/{faxId}.{tiff|pdf}
  exports/{exportId}.csv
bucket: {STORAGE_BUCKET_PREFIX}-platform
  brand/{resellerId}/{assetId}.{png|svg|ico}
```

- Server-side encryption is enabled on every bucket. Public access is always blocked.
- Clients access objects only through presigned URLs, with TTL ≤ 5 min for downloads and ≤ 15 min for uploads.
- Every bucket carries one CORS rule so browsers can use those URLs from the console's origin (G-80): `PUT`, `GET` and `HEAD` from any origin, the `Content-Type` header, no credentials, no exposed headers. `@cuc/storage` sets it when it provisions a bucket and re-applies it once per process per bucket, the first time the process presigns a URL there, so existing tenant buckets get it after a deploy without listing them. Any origin is safe because every URL is individually signed and short-lived.
- A ready media asset's converted audio is served through `GET /v1/tenants/{t}/media-assets/{id}/download-url` (`media.read`): a presigned GET for `16k.wav` (or `8k.wav` with `?variant=8k`), so the console can play prompts and hold music back. The raw upload is never served.
- Retention runs on lifecycle rules set from the tenant's retention policy (recordings, voicemail, fax, exports).
- Every object's metadata row (in the owning service) records `sha256`, `size`, `content_type`, and `object_key`. Objects are never listed to discover data. The DB is the index.

## 5. Events (D-004)

Transport: **NATS JetStream**, with one stream per domain (`ORG`, `IDENTITY`, `PBX`, `TRUNK`, `CALLFLOW`, `CALL`, `CDR`, `RECORDING`, `VOICEMAIL`, `SMS`, `FAX`, `AUDIT`).

Publishing uses the **transactional outbox**: the service writes its business rows and an `outbox` row in the same DB transaction, and a relay publishes and marks the row sent. Consumers are durable, deduplicate by event `id`, and are idempotent.

**Retention (G-55).** Neither copy of an event is kept for ever. The relay deletes published `outbox` rows once they are `OUTBOX_RETENTION_DAYS` old (7 by default; unpublished rows, parked ones included, are never deleted), and every stream has a `max_age` of `NATS_STREAM_MAX_AGE_DAYS` (7 by default), set by `ensureStreams()` at each service's startup, including on streams that already exist. A consumer that is down longer than that loses what it missed. Events never carry credentials: a password-reset or invitation token is issued by identity-service when notification-service sends the email ([06](06-services.md#identity-service)), so the reset and invitation events carry ids only.

Envelope:

```json
{
  "id": "uuidv7",
  "type": "pbx.extension.created",
  "schemaVersion": 1,
  "occurredAt": "2026-09-11T14:03:22.114Z",
  "orgContext": { "tenantId": "…", "resellerId": "…" },
  "actor": { "type": "user", "id": "…", "orgId": "…" },
  "correlationId": "request-or-call-id",
  "data": { }
}
```

Subject naming: `{domain}.{entity}.{verb}`, for example `org.tenant.suspended`, `trunk.trunk.updated`, `call.channel.answered`, `call.lost`, `cdr.record.created`. Event schemas live in `@cuc/api-contracts` and are versioned. A breaking change needs a new `schemaVersion` and a dual-publish period.

Principal event consumers:

| Consumer | Consumes |
|---|---|
| telephony-config | `org.tenant.*`, `org.domain.*`, `org.certificate.issued` (SIP proxy certificates only), `pbx.*`, `trunk.*`, `callflow.flow.published`, `recording.policy.*` |
| call-control | `pbx.queue.*`, `pbx.conference.*`, `org.tenant.suspended` (tear down calls) |
| cdr-service | `call.lost` |
| chat-service | `identity.user.*`, `org.tenant.*` |
| notification-service | `voicemail.message.created`, `fax.received`, `identity.user.password_reset_requested`, `identity.invitation.created`, `identity.user.mfa_reset` |
| analytics-service | `cdr.record.created`, `call.*`, queue events |
