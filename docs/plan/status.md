# Implementation status

Evidence-based status of [implementation-plan.md](implementation-plan.md), judged from the code (`services/*`, `packages/*`, `apps/console/lib`, `telephony/*`, `infra/*`, `tests/*`) and `git log`, not from the docs. "G-xx" refers to [decisions.md](../decisions.md). Snapshot: branch `main` at `251ef45`, 2026-09-24; Stage 5 rows updated for call recording (G-111) on 2026-09-25; S1-15 (read permissions, G-10) added on 2026-09-25; S5-16 (voicemail audio) added on 2026-09-25.

**Done** = the task's scope exists and has tests; known caveats are named. **Partial** = some of the scope exists. **Not started** = no code.

## Summary

| Stage | Done | Partial | Not started |
|---|---|---|---|
| S0 Foundations (10) | 10 | 0 | 0 |
| S1 Orgs, identity, single-node (16) | 14 | 1 | 1 |
| S2 Core telephony (20) | 17 | 3 | 0 |
| S3 Console MVP (11) | 11 | 0 | 0 |
| S4 HA and scale (11) | 0 | 4 | 7 |
| S5 Recording, voicemail features, monitoring (11) | 7 | 1 | 3 |
| S6 Full UC (7) | 0 | 0 | 7 |
| S7 Extended features (7) | 0 | 0 | 7 |
| S8 Device provisioning (4) | 0 | 3 | 1 |
| Release readiness (7) | 1 | 1 | 5 |
| **Total (104)** | **60** | **13** | **31** |

Milestones: M1 (S1) reached except API-key auth and organisation deletion (S1-16, added later). M2 (S2 + S3) reached in code, with the caveats below. M3, M4 not started.

Services with an empty `src` (verified, no files): `analytics-service`, `chat-service`, `fax-service`, `provisioning-service`, `sms-service`. `example-service` is the S0-08 sample.

## Stage 0

| ID | Status | Evidence |
|---|---|---|
| S0-01 | Done | pnpm workspace, `turbo.json`, `.nvmrc`, `eslint.config.js`, `vitest.config.ts`, `tsconfig.base.json` |
| S0-02 | Done | `packages/config`, `logger`, `http` (`route-guard.ts` enforces `permission` and `dataClass`), each with `test/` |
| S0-03 | Done | `packages/db` (`scoped.ts`, `unscoped.ts`, `cli.ts`); `packages/testing/src/cross-tenant.ts` probe harness |
| S0-04 | Done | `packages/events` (`outbox.ts`, `relay.ts`, `consumer.ts`), `test/relay.test.ts` |
| S0-05 | Done | `infra/compose/docker-compose.yml` (MariaDB, Redis, NATS, MinIO, Mailpit), `Makefile`, `seed.sh` |
| S0-06 | Done | `.github/workflows/ci.yml`: `check`, `sip`, `console` jobs, nightly and by hand (G-110) |
| S0-07 | Done | `tools/brand-leak` + `brand-leak.config.json`; CI runs it on source and `build/web` |
| S0-08 | Done | `tools/gen` (service template), `services/example-service` |
| S0-09 | Done | `packages/crypto` (`kek.ts`, `envelope.ts`) with tests |
| S0-10 | Done | `packages/storage`; CI runs against a real MinIO |

## Stage 1

| ID | Status | Evidence |
|---|---|---|
| S1-01 | Done | `services/org-service` (`domain/org.ts`, migrations). Gap: no hard delete or data export (G-11) |
| S1-02 | Done | `routes/org.routes.ts` (resellers, tenants, suspend/resume), `cli/bootstrap-master.ts`, outbox events |
| S1-03 | Done | `routes/domain.routes.ts` (base domains, verify via `dns-resolver.ts`, tenant domain) |
| S1-04 | Done | `routes/brand.routes.ts` (brand, asset presign, `/v1/public/brand`, `/v1/session/brand`) |
| S1-05 | Done | `services/identity-service`: login, TOTP MFA, refresh cookie, JWKS, reset, invitations, MFA reset |
| S1-06 | Done | `packages/authz` (`hard-rules.ts`, `roles.ts`); identity `roles.routes.ts`, `grants.routes.ts` |
| S1-07 | Done | `packages/audit`, identity `audit.consumer.ts`, `GET /v1/orgs/:orgId/audit-events`. Gaps: G-12 (partition upkeep), G-15 (not all writes audited) |
| S1-08 | Partial | `services/api-gateway`: JWT auth, signed context, rate limit, CORS, path routing. API-key auth returns `api_key_auth_not_implemented` (G-14); no WebSocket |
| S1-09 | Done | `pbx-config-service` extensions, SIP credentials, HA1/HA1B, reveal and reset-password routes |
| S1-10 | Done | `telephony/freeswitch` (Dockerfile, conf), neutral identity, OpenSIPs-only ACL |
| S1-11 | Done | `telephony/opensips` (`opensips.cfg.template`, db-schema), neutral headers |
| S1-12 | Done | `telephony-config` read model, `opensips-projection.repo.ts`, `reconcile.ts` (reconciles itself only, G-16) |
| S1-13 | Done | `telephony-config` `routes/fs.routes.ts` (`/fs/directory`, `/fs/dialplan`) |
| S1-14 | Done | `tests/sip` (`scenarios.test.ts`, `register.xml`, `answer_call.xml`); CI `sip` job |
| S1-15 | Done | G-10: `packages/authz` `READ_TWINS` (21 `.read` permissions, `.manage` implies `.read`), support roles; identity `permission-lookup.ts` and `/me` expand implied reads; `@cuc/http` resolver; 55 GET routes declare the read; console `core/permissions.dart` (`holds`), sections and read-only screens (`test/read_only_test.dart`) |
| S1-16 | Not started | Organisation deletion (G-11) |

## Stage 2

| ID | Status | Evidence |
|---|---|---|
| S2-01 | Done | `trunk-service` trunk CRUD, IPs, encrypted credentials, `/reveal`, `/status` |
| S2-02 | Done | `telephony-config` `trunk.consumer.ts` to registrant, address, dr_gateways; `tests/sip/test/trunk_registration.test.ts` |
| S2-03 | Done | `pbx-config-service` `routes/did.routes.ts`; `fs.routes.ts` resolves extension, ring_group, flow, queue, voicemail; `trunk_did_routing.test.ts` |
| S2-04 | Done | `trunk-service` `outbound-route.ts`, `e164.ts`; `outbound_failover.test.ts` |
| S2-05 | Done | `domain/fraud-limits.ts`; `toll_fraud.test.ts`. Caveat: CPS is one platform constant, not per-tenant (G-31) |
| S2-06 | Partial | `emergency-route.routes.ts`, `emergency-locations`, `emergency_calling.test.ts`. Missing: notification hook on emergency calls; `X-Emergency-Location` is a generic header (G-33) |
| S2-07 | Done | `pbx-config-service` `media-asset.routes.ts`, `services/media-worker` transcode; `media_playback.test.ts` |
| S2-08 | Done | `ring-group.routes.ts`; ring-group dialplan in `fs.routes.ts` |
| S2-09 | Done | `packages/callflow-ir` (9 node types, validator, compiler), `services/callflow-service` (draft, validate, publish, rollback) |
| S2-10 | Done | `telephony/freeswitch/scripts` flow runner; `call_flow.test.ts`, `tests/lua`. Caveats G-43, G-46 |
| S2-11 | Done | `services/call-control` (`esl/client.ts`, `normalize.ts`, `redis/registry.ts`) |
| S2-12 | Done | `packages/affinity`; call-control `affinity/manager.ts` and `/internal/v1/affinity/...` |
| S2-13 | Done | queue/agent/tier CRUD in pbx-config-service, callcenter projection; `queue.test.ts`. G-47: one related bug left open |
| S2-14 | Done | `parking-lot.routes.ts`, `parking.test.ts`. `valet_parking` return-on-timeout unimplemented (G-48) |
| S2-15 | Done | `conference-room.routes.ts`, `conference.test.ts` (audio, PIN). Video fields absent (G-50) |
| S2-16 | Partial | `services/voicemail-service` (mailboxes, messages, greeting, PIN), Lua app, `voicemail.test.ts`. MWI event has no consumer (G-42) |
| S2-17 | Partial | SUBSCRIBE dialog-info handled in `opensips.cfg.template`; `presence.test.ts` proves handshake and one NOTIFY. State transitions unproven (G-38) |
| S2-18 | Done | `services/cdr-service`: `/ingest/json-cdr`, CDR v1, `/cdrs`, `/cdr-exports`, `/billing-records` (D-013). Gaps: G-51 fields, G-52 partitions, G-53 master rollup |
| S2-19 | Done | `freeswitch-2` in compose; dispatcher over two nodes; per-test cleanup covers both |
| S2-20 | Done | 15 files in `tests/sip/test`; CI per-PR smoke plus nightly full suite |

## Stage 3

| ID | Status | Evidence |
|---|---|---|
| S3-01 | Done | `apps/console` Flutter app; CI regenerates and checks the API client and OpenAPI snapshot |
| S3-02 | Done | `features/orgs/brand_page.dart`, `brand_test.dart`, `golden_test.dart`; re-theme after login (G-58) |
| S3-03 | Done | `services/notification-service`: invitation, password-reset, MFA-reset templates (MJML, text). Sender is platform address (G-57) |
| S3-04 | Done | `features/auth/*` (login, MFA, reset, invite); `auth_flows_test.dart` |
| S3-05 | Done | `shell/sections.dart`, `core/acting.dart`, `core/permissions.dart`; `act_as_test.dart` |
| S3-06 | Done | `orgs_page.dart`, `reseller_page.dart`; `reseller_screens_test.dart` |
| S3-07 | Done | `orgs_page.dart` (tenants), `domains_panel.dart`, `brand_page.dart`, `trunks_page.dart`, `outbound_routes_page.dart` (G-106) |
| S3-08 | Done | `pbx/resource.dart` defs (extensions, DIDs, ring groups, queues, agents, rooms, parking, schedules, emergency locations), `users_page.dart`, `media_page.dart` |
| S3-09 | Done | `apps/console/lib/canvas/*`; `test/canvas` |
| S3-10 | Done | `features/callflow/builder/*` (palette, properties, local validation, publish); `test/callflow` |
| S3-11 | Done | `tests/e2e/test/m2-journey.test.ts`, `apps/console/test/journey_test.dart`; live carrier call through a flow (G-101) |

## Stage 4

| ID | Status | Evidence |
|---|---|---|
| S4-01 | Partial | O-1 recommendation in decisions.md only; no ADR or topology doc; `infra/deploy` is empty |
| S4-02 | Partial | dispatcher probing (`ds_ping_interval`) and round-robin over two nodes; no weights or draining |
| S4-03 | Partial | leases live in Redis via call-control; compose runs one call-control replica; no multi-replica test |
| S4-04 | Not started | `call-control/src/events.ts` only comments the `call.lost` sequence; no teardown, synthetic CDRs, or Redis rebuild |
| S4-05 | Not started | `cachedb_redis` is loaded but no affinity lookup in `route{}` |
| S4-06 | Not started | no clusterer, dialog replication, or VIP config |
| S4-07 | Not started | compose has single MariaDB, Redis, NATS |
| S4-08 | Not started | no chaos tests |
| S4-09 | Not started | no capacity benchmarks or sizing guide (`telephony-config/src/bench.ts` is unrelated) |
| S4-10 | Partial | O-7 recorded as deferred in decisions.md; no RTPengine |
| S4-11 | Not started | `infra/deploy` empty |

## Stage 5

| ID | Status | Evidence |
|---|---|---|
| S5-01 | Done | `services/recording-service`: policies by tenant, extension, queue and DID and by direction (`domain/policy.ts`, narrowest scope wins, ties go to not recording), `/internal/v1/recordings/evaluate` and `/register`. No agent scope (G-111) |
| S5-02 | Done | telephony-config `recording-client.ts` (cached, fails open and flags the call) and `recordingActions` in `xml.ts`: announcement as early media, then `record_session` armed with `execute_on_answer`, into the spool. Covers extension, outbound, and DID to extension, ring group or queue; not calls through an IVR flow (G-111) |
| S5-03 | Done | `recording-service/src/uploader` (settle, presigned PUT, server-side size and MD5 check, delete, backoff, stuck-file alert and metrics); one sidecar per node in compose on a shared tmpfs spool; verified live by `tests/sip/test/recording.test.ts` (G-111) |
| S5-04 | Done | search with filters and cursor paging, play and download URLs, delete; per-request grants scoped to extension, queue or DID (`authorize.ts`, identity `/access`); every URL issuance and delete audited |
| S5-05 | Done | tenant retention days (`recording_settings`), `retention.ts` sweep (audio deleted, row marked expired, stale pending marked failed) and an S3 lifecycle rule as a backstop |
| S5-06 | Not started | no transcription adapter (O-3 open) |
| S5-07 | Done | voicemail-to-email: `voicemail.consumer.ts`, `voicemail.mjml`, mailbox email settings in voicemail-service (G-107). Not tried with a real call or SMTP server |
| S5-08 | Not started | api-gateway has no WebSocket hub |
| S5-09 | Not started | call-control has no listen/whisper/barge |
| S5-10 | Partial | Voicemail (`features/voicemail`), Call records (`features/cdr`) and Recordings (`features/recordings`: list, filters, play, download, delete, rules, retention) screens exist; `/monitoring` and `/reports` are still placeholders |
| S5-16 | Done | Voicemail audio reaches storage: `voicemail.lua` records to `vm-<id>.wav` in the spool and leaves it; the node uploader (`recording-service/src/uploader`, `createVoicemailApi`) delivers it to voicemail-service's `routes/upload.routes.ts` (`upload-url`, `complete` verifying size and MD5 against storage, `fail`); pending sweep (`pending-sweep.ts`). Tests: `voicemail-service/test/upload.routes.test.ts` (real MinIO), uploader voicemail cases. The live check in `tests/sip/test/voicemail.test.ts` (audio playable, spool emptied) is written; not yet run (G-2) |

## Stage 6

| ID | Status | Evidence |
|---|---|---|
| S6-01 | Not started | conference rooms are audio only (G-50) |
| S6-02 | Not started | none |
| S6-03 | Not started | O-4 recommends ejabberd; nothing deployed |
| S6-04 | Not started | `services/chat-service` has no source |
| S6-05 | Not started | none |
| S6-06 | Not started | none |
| S6-07 | Not started | none |

## Stage 7

| ID | Status | Evidence |
|---|---|---|
| S7-01 | Not started | `services/fax-service` has no source |
| S7-02 | Not started | same |
| S7-03 | Not started | `services/sms-service` has no source; O-8 open |
| S7-04 | Not started | none |
| S7-05 | Not started | `services/analytics-service` has no source |
| S7-06 | Not started | none |
| S7-07 | Not started | Reports section is a placeholder |

## Stage 8

| ID | Status | Evidence |
|---|---|---|
| S8-01 | Partial | built inside pbx-config-service, not a separate service: device MAC registry (`device.repo.ts`), per-device credentials, `/v1/public/provision/yealink/:file`, HTTPS-only (G-103, G-104) |
| S8-02 | Partial | Yealink template only (`domain/provisioning.ts`); no BLF keys, time zone, or codec settings; no Polycom, Snom, Grandstream |
| S8-03 | Not started | no vendor redirection integration |
| S8-04 | Partial | Phones screen (`devicesDef`, `provisioning_dialog.dart`); no key layouts |

## Cross-cutting release readiness

| Item | Status | Evidence |
|---|---|---|
| Security review (auth, H1, secrets, SIP exposure) | Not started | no review record; `SECURITY.md` is a disclosure policy only |
| External penetration test | Not started | none |
| Backup and restore runbook | Not started | no runbook in the repo |
| Operations runbooks | Not started | none |
| License decision (O-6) | Not started | O-6 open; no `LICENSE` file |
| Emergency calling scope (G-1) | Partial | routes, locations, and dialplan built; notification hook and reseller documentation missing |
| Billing data access (D-013) | Done | `billing.read` permission, `GET /v1/tenants/:tenantId/billing-records`; master rollup missing (G-53) |

## Built but not in the plan

| Work | Nearest task | Evidence |
|---|---|---|
| Yealink auto-provisioning (device registry, credentials, config serving) | S8-01, S8-02 | G-103; `pbx-config-service` `device.routes.ts`, `provision.routes.ts` |
| Connect-a-phone panel and SIP endpoint route | Unplanned (near S3-08) | G-102; `GET /v1/tenants/:tenantId/sip-endpoint`; `connect_phone_dialog.dart` |
| Outbound proxy: phones use reseller `sip.<base domain>` | Unplanned (near S1-11) | commit 9a57885; G-105 |
| SIP over TLS at the edge (5061) | Unplanned (near S1-11) | G-102 record; `tests/sip/test/tls.test.ts`; OpenSIPs certificates from DB |
| HTTPS at the gateway, SNI certificates, HTTP redirect, security headers | Unplanned (near S1-08) | G-104; `api-gateway` `tls.ts`, `certificate-source.ts`, `security-headers.ts` |
| Console hosted by the gateway under a strict CSP | Unplanned (near S3-01) | `api-gateway/src/console-hosting.ts` |
| ACME / Let's Encrypt issuance and renewal in the background | Unplanned | G-105; `org-service` `acme-issuer.ts`, `certificate-worker.ts`, `acme-settings.routes.ts`; gateway `acme-challenge.ts` |
| Certificate screens and Let's Encrypt settings | Unplanned (near S3-06) | `features/certificates/certificates_page.dart` |
| Reseller console hostnames and DNS verification | Near S1-03 | `console-hostnames` routes, `dns-resolver.ts` |
| Per-extension call handling: DND, forwarding, simultaneous ring (G-109) | Unplanned (parity 1a) | `pbx-config-service` `call-handling.routes.ts`; `telephony-config` `buildCallHandlingDialplanDocument`; console `call_handling_dialog.dart`. Not tried on a real call |
| Platform public address and reseller DNS records | Unplanned | `org-service` `network.routes.ts`, migration 005; console Certificates and the reseller Certificates tab |
| Platform health screen | Unplanned | `platform-health.ts`, `platform_health_page.dart` |
| Extension SIP password reset; `password_reset.test.ts` | Near S1-09 | `POST .../extensions/:id/reset-password` |
| Hostname-based org resolution at sign-in | Near S3-04 | G-61 |
| Admin reset of a user's MFA | Near S3-04 | G-100 |
| Nightly CI split, self-hosted runner, per-suite JetStream | Near S0-06 / S2-20 | `.github/workflows/ci.yml` |
| `SECURITY.md`, `CODEOWNERS`, `CODE_OF_CONDUCT.md` | Near release readiness | repo root |

## Ten biggest gaps

1. Recording (S5-01 to S5-05): no service, policy, upload, or retention.
2. No HA (S4-03 to S4-08): no failover handling, OpenSIPs clustering, data-store HA, or chaos tests; only one dispatcher path over two nodes.
3. No production deployment manifests or topology ADR (S4-01, S4-11).
4. Console has no monitoring, recordings, or reports screens (S5-10, S7-07). Voicemail, call records and outbound routes have screens now (G-106, G-107).
5. Release readiness: no security review, pen test, backup/restore, runbooks, or license (O-6).
6. Voicemail transcription and MWI wiring (S5-06, G-42, G-108). Voicemail-to-email is built (G-107).
7. No realtime layer: no gateway WebSocket, live calls, monitor/whisper/barge, or wallboards (S5-08, S5-09, S7-06).
8. Emergency calling incomplete: no emergency-call notification, carrier-specific location format unresolved (S2-06, G-1, G-33).
9. Fax, SMS, chat, video, analytics all unbuilt (S6, S7); five services are empty.
10. API-key auth missing (G-14); provisioning limited to Yealink with no BLF keys and no zero-touch redirection (S8-02, S8-03); audit covers only some writes (G-15).

## Built features catalog

| Area | Capability | Where |
|---|---|---|
| Orgs | Resellers, tenants: create, edit, suspend, resume | org-service `/v1/resellers`, `/v1/tenants`; console Resellers, Tenants |
| Orgs | Act as a tenant or descendant | console shell (`acting.dart`) |
| Orgs | Base domains, tenant domain, console hostnames | org-service `base-domains`, `tenants/:id/domain`, `console-hostnames`; console Domains |
| Brand | Reseller brand editor, images, public and session brand | org-service `/v1/resellers/:id/brand`, `/v1/public/brand`, `/v1/session/brand`; console Brand |
| Users and roles | Login, MFA, refresh, reset, invitations, MFA reset (confirmed with the admin's own code; other admins emailed) | identity-service `/v1/auth/*`, `.../users/:userId/mfa-reset`; console auth screens |
| Users and roles | Users list, rename, disable; roles and grants | identity-service `/users`, `/roles`, `/grants`; console Users |
| Extensions and devices | Extensions, SIP credentials, reveal, reset password | pbx-config-service `/extensions`; console Extensions |
| Extensions and devices | Connect a phone; Yealink phones by MAC | `/sip-endpoint`, `/devices`, `/v1/public/provision/yealink/:file`; console Phones |
| DIDs and trunks | DIDs with destination types | pbx-config-service `/dids`; console Phone numbers |
| DIDs and trunks | Trunks (register or IP auth), IPs, status; outbound routes; emergency route | trunk-service `/trunks`, `/outbound-routes`, `/emergency-route`; console Trunks and Outbound routes |
| Groups | Ring groups | `/ring-groups`; console Ring groups |
| Groups | Queues, agents, tiers | `/queues`, `/agents`, `.../tiers`; console Queues |
| Groups | Parking lots; conference rooms (audio, PIN) | `/parking-lots`, `/conference-rooms`; console Parking lots, Conference rooms |
| Call flows | Draft, validate, publish, rollback, versions; visual builder | callflow-service `/flows`; console Call flows |
| Voicemail | Mailboxes, PIN reset, greeting upload, messages, play URL, email settings, voicemail to email | voicemail-service `/voicemail/mailboxes`; notification-service `voicemail.consumer.ts`; console Voicemail (no mailbox create or greeting upload) |
| Schedules | Business hours and holidays; used by `time_condition` | pbx-config-service `/schedules`; console Schedules |
| Emergency | Emergency locations per extension | `/emergency-locations`; console Settings |
| Media | Upload, transcode, playback via `http_cache` | pbx-config-service `/media-assets`, media-worker; console Media |
| CDR | CDR list and detail, async export, billing records | cdr-service `/cdrs`, `/cdr-exports`, `/billing-records`; console Call records (billing records: API only) |
| Audit | Audit events by org | identity-service `/audit-events`; console Audit |
| Certificates | Let's Encrypt settings, issuance, renewal; SIP and console certs | org-service `/v1/platform/acme-settings`, `/certificates`; console Certificates |
| Provisioning | HTTPS-only Yealink config with per-device credentials | pbx-config-service `provision.routes.ts`; console Phones |
| Platform | Health screen; dashboard; email for invitations and resets | api-gateway `platform-health.ts`; notification-service |
