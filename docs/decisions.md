# Decisions, open questions & gaps

Status values:

- **Accepted**: decided by the owner.
- **Proposed**: a recommendation made in these docs that needs sign-off before the stage listed in *Needed by*.
- **Open**: no recommendation yet, or the decision needs owner input.

## 1. Decision register

| ID | Decision | Status | Needed by | Where |
|---|---|---|---|---|
| D-001 | pnpm workspaces + Turborepo monorepo. Flutter app built separately in CI. | **Accepted** (2026-09-12) | S0 | [01 §5](architecture/01-system-overview.md#5-monorepo-layout) |
| D-002 | **The Master tier is completely unbranded.** No platform or operator branding on any surface. "ConductorUC" is a codebase name only. Resellers are the sole brand holders, with neutral fallback. | **Accepted** | S0 | [02 §5](architecture/02-tenancy-and-branding.md#5-branding) |
| D-003 | Fastify + TypeBox + Kysely + pino + OTel for services | **Accepted** (2026-09-12) | S0 | [09](architecture/09-engineering-conventions.md) |
| D-004 | NATS JetStream event bus with transactional outbox. Redis is kept out of durable messaging because the SAD makes Redis ephemeral. | **Accepted** (2026-09-12) | S0 | [05 §5](architecture/05-data-architecture.md#5-events) |
| D-005 | One MariaDB cluster with a schema per service. Tenant isolation through a mandatory `scoped(ctx)` data-access layer. | **Accepted** (2026-09-12) | S0 | [05 §1–2](architecture/05-data-architecture.md) |
| D-006 | FreeSWITCH gets all directory, dialplan, and module config from `telephony-config` via `mod_xml_curl`. Nodes hold no tenant config. | Proposed | S1 | [03 §3](architecture/03-signaling-and-media.md#3-freeswitch) |
| D-007 | OpenSIPs is registrar, auth point, and trunk edge (`uac_registrant`, `uac_auth`, `drouting`). FS has no gateways. | Proposed | S1 | [03 §1](architecture/03-signaling-and-media.md#1-division-of-responsibility) |
| D-008 | Call flows compile to an immutable, versioned JSON IR executed by a Lua runner on FS. The alternative (generating XML dialplan or `ivr.conf` menus) is rejected because it handles branching, loops, and versioning poorly. | Proposed | S2 | [03 §4](architecture/03-signaling-and-media.md#4-call-flows-ivr--auto-attendant) |
| D-009 | Voicemail audio, greetings, and prompts live centrally in S3. Voicemail runs as a Lua app backed by `voicemail-service`, not stock `mod_voicemail` storage. This is required for non-pinned nodes. | Proposed | S2 | [03 §5](architecture/03-signaling-and-media.md#5-stateless-node-rules-for-features) |
| D-010 | Queues, parking lots, and conference rooms are pinned to one node at a time through Redis affinity leases | Proposed | S2 (abstraction) / S4 (multi-node) | [04 §3.3](architecture/04-high-availability.md#33-resource-affinity-leases) |
| D-011 | Recordings go to a transient node spool, then an uploader pushes them to S3 and deletes the local copy. No durable node storage. | Proposed | S5 | [03 §6](architecture/03-signaling-and-media.md#6-recording-pipeline-summary) |
| D-012 | Short-lived EdDSA JWT access tokens + rotating refresh cookies. MFA required for master and reseller users. | Proposed | S1 | [07 §2](architecture/07-security-and-permissions.md#2-tokens) |
| D-013 | **Reseller access to billing data.** See conflict C-1. | **Open** | S2 | below |
| D-014 | Five services added to the SAD §7 list: api-gateway, pbx-config-service, telephony-config, call-control, notification-service | Proposed | S1 | [06](architecture/06-services.md) |
| D-015 | Voicemail storage core is pulled forward from Phase 5 to Stage 2 (email and transcription stay in Stage 5) | Proposed | S2 | [plan](plan/implementation-plan.md) |

**Stage 0 sign-off (2026-09-12).** D-001, D-003, D-004, and D-005 were accepted together. Three of
them were already implemented and merged when they were signed off — D-001 in S0-01, D-003 and
D-005 across S0-02 and S0-03 — so the sign-off records what the code already does. D-004 was
accepted ahead of S0-04, which is the first task to build on it. Every other *Proposed* decision
still needs sign-off before the stage in *Needed by*.

## 2. Open questions

From SAD §12, with recommendations:

| ID | Question | Recommendation | Needed by |
|---|---|---|---|
| O-1 | Container orchestrator | **Hybrid.** Run FreeSWITCH and OpenSIPs on dedicated hosts or VMs as containers with host networking. Large RTP UDP port ranges and real IP visibility are awkward under Kubernetes CNI networking. Run stateless services on Kubernetes, or on Nomad if the team wants one tool for both. Develop on Docker Compose until then. Keep services 12-factor so the decision stays cheap. | S4 |
| O-2 | CDR / billing API schema | A v1 draft is in [06 §cdr-service](architecture/06-services.md#cdr-service). Freeze it in S2-11 after review against one target billing system's import format. | S2 |
| O-3 | Speech-to-text provider | Keep it behind a `TranscriptionProvider` interface and evaluate on accuracy for telephony audio (8 kHz), price, data-residency options, and data-retention terms. The first adapter is picked in S5-06. | S5 |
| O-4 | XMPP server | **ejabberd.** It has mature clustering, many virtual hosts (one per tenant), MUC, MAM with SQL storage (MariaDB), external/HTTP auth, and an admin HTTP API for provisioning. Prosody is the lighter alternative if clustering isn't needed. | S6 |

New questions raised during breakdown:

| ID | Question | Recommendation | Needed by |
|---|---|---|---|
| O-5 | Container image registry & release versioning | Semver per service. Images tagged `{service}:{version}` and `:{git-sha}`. | S0 |
| O-6 | Open-core license for platform code | Needs an owner decision. Note the upstream licenses: FreeSWITCH is MPL 1.1 and OpenSIPs is GPLv2. The platform services are separate programs that talk over network protocols, but modified upstream code or configs shipped in images must follow their licenses. Evaluate AGPLv3 (protects against closed SaaS forks) vs. Apache-2.0/MPL-2.0 (friendlier to integrators). | Before first public release |
| O-7 | Media anchoring (RTPengine) at the edge | Deferred. Without it, FS node media IPs appear in SDP, so topology hiding covers signaling only. Decide in S4 based on NAT and topology-hiding needs. | S4 |
| O-8 | Which carriers get SMS adapters first | Owner to name the carriers most common among target resellers | S7 |
| O-9 | Bucket-per-tenant vs. prefix-per-tenant | Implement both in `@cuc/storage`, with per-tenant buckets as the default per the SAD. Confirm the chosen S3 provider's bucket limits before production. | S5 |
| O-10 | Per-tenant logo under a reseller brand | Not in v1. Resellers brand; tenants inherit. | Post-v1 |
| O-11 | Where the operator's own direct customers live | A normal "house" reseller. Master still provisions resellers only. | S1 |
| O-12 | Recording consent and legal notices | Provide a per-policy consent announcement. Legal defaults are the tenant's responsibility and are documented as such. | S5 |
| O-13 | Recordings in flight when a node dies | Accept loss in v1, or add a replicated spool (for example, a small per-node volume replicated via the uploader). The recommendation is to accept loss and alert. | S5 |
| O-14 | In-browser listen/whisper/barge | Out of scope (no softphone). The supervisor's own SIP device is used. Revisit if WebRTC is ever added. | S5 |
| O-15 | Bridge SIP "on a call" state into XMPP presence | Nice to have. Optional adapter in S6. | S6 |
| O-16 | Moving a tenant between resellers | Master-only, audited, post-v1 | Post-v1 |

## 3. Conflicts & gaps found in the SAD

| ID | Issue | Detail | Proposed resolution |
|---|---|---|---|
| **C-1** | Billing API vs. the reseller private-data wall | SAD §6 says the CDR/billing API lets **tenants/resellers** integrate billing, but SAD §3 says resellers have **no access** to tenant CDRs. Resellers usually do the billing. | Define a separate **billing record** (usage data class): tenant, call ID, start, billable seconds, direction, trunk ID, destination number or prefix. Leave out recordings, legs, caller names, internal extension detail, and SIP metadata. Resellers get this through a `billing.read` API key. Full CDRs remain tenant-private. **Owner to confirm** whether resellers may see the full destination number and whether tenants must opt in. |
| **G-1** | Emergency calling not addressed | A multi-line telephone system in the US is subject to Kari's Law (direct 911 dialing without a prefix, plus on-site notification) and RAY BAUM'S Act (dispatchable location). Other countries have their own rules. With BYO trunks, location delivery depends on each carrier's E911 service. | Minimum in core, in S2: direct dial without a prefix, a priority emergency route per tenant, an emergency location per extension, a notification hook (email/SMS/console) on every emergency call, and the configured location passed to the carrier in the format that carrier supports. **Owner to set the regulatory scope** (countries in scope for v1). |
| **G-2** | Voicemail on stateless nodes | Stock `mod_voicemail` stores on node-local disk, which breaks "any node serves any tenant". | D-009 (central storage), pulled into S2 (D-015). |
| **G-3** | Queues, parking, and conferences are per-node in FreeSWITCH | Active-active with non-pinned nodes still needs a single owner per live queue, lot, or room. | D-010 affinity leases. |
| **G-4** | Trunk registration with N nodes | If every FS node registered every tenant trunk, carriers would see multiple competing registrations. | D-007 (OpenSIPs `uac_registrant`, clustered). |
| **G-5** | Prompts, greetings, and MOH storage not addressed | These are tenant uploads needed on every node. | Media assets in S3, played through `http_cache` (pbx-config-service). |
| **G-6** | Toll-fraud controls not addressed | This is the largest operational risk for a PBX platform. | [07 §6](architecture/07-security-and-permissions.md#6-abuse--fraud-controls), in S2. |
| **G-7** | Email delivery has no owner | Voicemail-to-email, fax-to-email, and password reset all need email, with branding. | notification-service (D-014). |
| **G-8** | "LCR" with no shared carrier pool | LCR here can only mean choosing among a single tenant's own trunks (priority, prefix rules, failover). | Per-tenant `drouting` groups. |
| **G-9** | SMS on BYO carriers | SMS isn't carried over the SIP trunk for most carriers. It needs each carrier's API. | Adapter model (O-8). |
