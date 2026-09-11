# ConductorUC — Software Architecture Document

**Version:** 1.1
**Author:** Paige Sullivan / Sullivan Technology
**Purpose:** Reference architecture for implementation planning. Intended to be broken into discrete implementation tasks (e.g., by Claude Code).

> This is the source architecture document. The detailed technical documentation derived from it lives in [`docs/architecture/`](architecture/), the staged plan in [`docs/plan/implementation-plan.md`](plan/implementation-plan.md), and decisions/open questions in [`docs/decisions.md`](decisions.md).

### Change log

| Version | Change |
|---|---|
| 1.0 | Initial architecture. |
| 1.1 | The **Master** tier is completely unbranded. It is the platform operator role, not a named company, and no platform or operator brand appears on any surface. Example tenant domains now use a configurable base domain. Affects §3 and §13. |

---

## 1. Executive Summary

ConductorUC is a multi-tenant, open source (open core) unified communications platform providing enterprise-class PBX functionality plus video conferencing, team chat, and call center features. It is not a hosted carrier — every tenant brings their own SIP trunks. The business model is not license revenue; it is paid custom development and support services layered on top of a freely available open core.

The platform is architected as a set of independently deployable microservices sitting behind an OpenSIPs signaling edge, with FreeSWITCH providing media handling and call/conferencing application logic, a Flutter web console for administration, and a three-level reseller hierarchy (master → reseller → tenant).

---

## 2. Goals and Non-Goals

### Goals
- Full enterprise PBX feature parity (queues, ring groups, auto attendants, hunt groups, call parking, presence)
- Full UC scope: voice, video conferencing, team chat/messaging
- Multi-tenant from the ground up, with white-label reseller support
- Active-active high availability across media nodes
- Open core codebase; monetization via services, not licensing
- Standards-based endpoints (SIP, XMPP) so customers can bring their own hardware/software clients

### Explicit Non-Goals (Out of Scope)
- Acting as a VoIP carrier (no shared carrier pool — every tenant supplies its own trunk)
- Billing, invoicing, or tax calculation (a CDR/billing API is exposed instead; billing is left to reseller/tenant's own platform of choice)
- Number porting (handled entirely by the reseller, outside the platform)
- Building or maintaining softphone or mobile client apps (standard SIP/XMPP endpoints only — customers bring their own clients)
- Self-serve tenant signup at the master level (master provisions resellers only; resellers self-provision their own tenants)

---

## 3. Business & Tenancy Hierarchy

Three fixed levels, no deeper sub-reselling:

```
Master (platform operator — unbranded)
  └── Reseller / Agent (white-labeled)
        └── Tenant (brings own carrier trunk)
```

**Provisioning responsibility:**
- Master provisions **reseller** accounts only.
- Resellers self-serve provision their own **tenants** and those tenants' trunk configuration.
- There is no tenant-level self-signup.

**Visibility / permission model:**
| Role | Own config/admin data | Other resellers' data | Tenant private data (recordings, CDRs) |
|---|---|---|---|
| Master | Full | Full | Full |
| Reseller | Full, for own tenants | None | **No access** |
| Tenant | Full, for own org | N/A | Full, for own org |

**Branding:**
- **Master is completely unbranded.** The Master tier has no brand identity: no product name, logo, company name, or color scheme. No "ConductorUC" or operator branding appears on any surface. The master console uses a neutral theme.
- Resellers get full white-label branding (their logo/name throughout the console for their tenants).
- Any surface that has no reseller brand, including the master console and resellers that haven't configured a brand, renders neutral.
- "ConductorUC" is the project and codebase name only. It never appears on user-facing surfaces.

**Multi-tenancy mechanism:** Domain-based, using FreeSWITCH's native multi-domain support. One subdomain per tenant (e.g., `client-name.<platform-base-domain>`; the base domain is deployment configuration, and resellers may supply their own). This is the core isolation boundary at the media/signaling layer; the application layer additionally scopes all data by tenant ID.

---

## 4. Technology Stack

| Layer | Technology | Rationale |
|---|---|---|
| SIP edge / signaling | **OpenSIPs** | SIP routing, load balancing, least-cost routing, topology hiding across FreeSWITCH nodes |
| Media / call logic | **FreeSWITCH** | IVR, voicemail, conferencing, native video conferencing, per-tenant domains |
| Call-state coordination | **Redis** | Shared registry tracking which FreeSWITCH node owns which active call, used for failover |
| Chat / presence | **XMPP** (dedicated microservice) | Team messaging and presence, separate from voice signaling |
| Database | **MariaDB** | Tenant, user, config, and billing-adjacent metadata |
| Object storage | **S3-compatible storage** | Per-tenant bucket for call recordings |
| Backend services | **Node.js / TypeScript** | Chosen over Go for development velocity given existing team familiarity |
| Frontend | **Flutter / Dart (web only)** | Single unified app, role-based views, not compiled to native desktop/mobile |
| Deployment | **Containerized** (orchestrator TBD — Kubernetes vs. Docker Swarm/Nomad) | Independent scaling of FreeSWITCH nodes and microservices across machines |

---

## 5. Signaling & Media Architecture

- **OpenSIPs** sits at the network edge as the SIP router. Responsibilities: load balancing across FreeSWITCH nodes, least-cost routing decisions, and topology hiding (tenants/carriers never see internal FreeSWITCH node addresses).
- **FreeSWITCH** handles all media and application-layer call logic: IVR execution, voicemail, conferencing, video conferencing, call parking, ring groups, hunt groups.
- Any FreeSWITCH node can serve any tenant — nodes are not tenant-pinned. This is required for active-active failover.
- Per-tenant SIP trunks only; there is no shared carrier pool. Each tenant supplies and owns its own carrier relationship.

### 5.1 Failover / High Availability
- Model: **active-active** across FreeSWITCH nodes.
- **Redis** acts as the shared call-state registry, tracking which node currently owns which in-progress call, enabling other nodes/OpenSIPs to make correct routing decisions after a node failure.
- Acceptable behavior: brief disruption to in-progress calls on failover. This is a deliberate simplification — **full state replication (mid-call survival with zero interruption) is not required for v1.**
- Implication for implementation: design the Redis schema around "call ownership" records with TTL/heartbeat, not full call-state snapshots.

---

## 6. Data Architecture

- **MariaDB**: system of record for tenant/reseller/master org data, users/extensions, permissions, trunk configuration, IVR/call-flow definitions, and any metadata needed to generate CDRs.
- **Redis**: ephemeral call-state/failover registry only — not a system of record.
- **S3-compatible object storage**: one bucket per tenant for call recordings. Recordings are never stored on FreeSWITCH nodes themselves.
- **CDR / Billing API**: a standard, documented API surface exposing call detail records and billing-relevant events, so tenants/resellers can integrate their own billing platform (e.g., PortaOne, JeraSoft, or a custom system). ConductorUC does not calculate charges, taxes, or invoices.

---

## 7. Microservices Breakdown

Backend is microservices, not a monolith, so individual services can be swapped/upgraded independently. Proposed service boundaries (to be refined during implementation planning — see [`architecture/06-services.md`](architecture/06-services.md) for the refined catalog):

1. **Tenant/Org Management Service** — master/reseller/tenant hierarchy, provisioning, white-label branding config
2. **Identity & Permissions Service** — auth, role-based access control, granular per-tenant permission grants (recording access, monitoring access, etc.)
3. **Trunk/Carrier Config Service** — per-tenant SIP trunk configuration
4. **Call Flow / IVR Service** — stores and serves the visual call-flow/IVR definitions built in the Flutter canvas; compiles/exposes them to FreeSWITCH
5. **CDR & Billing API Service** — ingests call detail records from FreeSWITCH, exposes the external billing integration API
6. **Recording Service** — manages per-tenant/per-extension recording permissions and S3-compatible storage lifecycle
7. **Voicemail Service** — voicemail-to-email delivery, optional cloud speech-to-text transcription integration
8. **Chat/Presence Service (XMPP)** — team messaging and presence, separate from SIP presence
9. **Analytics/Reporting Service** — call analytics dashboards, call center wallboards, queue reporting
10. **SMS Service** — SMS support for DIDs
11. **Fax Service** — T.38 fax over IP
12. **Device Provisioning Service** *(future)* — automatic provisioning for supported hard phones

---

## 8. Feature Set

### 8.1 Core PBX (enterprise parity — all in core, not premium tier)
- Call queues, ring groups, auto attendants
- Conferencing, call parking, hunt groups
- Presence
- Call center features: queue reporting, wallboards

### 8.2 Unified Communications
- **Video conferencing** — handled natively by FreeSWITCH (no separate WebRTC video service)
- **Team chat / messaging** — separate XMPP-based microservice, includes presence
- **T.38 fax over IP**
- **SMS support for DIDs**
- **Call analytics / reporting dashboards**

### 8.3 Voicemail & Recording
- Voicemail-to-email is standard for all tenants
- Voicemail transcription is optional, via a **cloud** speech-to-text API (not self-hosted)
- Call recording is a **granular permission** — configurable per tenant, per extension/agent — not an all-or-nothing tenant switch
- Recordings land in per-tenant S3-compatible storage

### 8.4 Endpoints
- No softphone or mobile app is built or maintained — standard SIP and XMPP endpoints are exposed; customers bring their own clients
- Native hard-phone support targeted for: **Yealink, Polycom, Snom, Grandstream**
- Automatic device provisioning is a **future** phase, not immediate scope

---

## 9. Frontend — Flutter Console

- Single unified Flutter **web-only** app (no native desktop/mobile compilation)
- Role-based views for Master, Reseller, and Tenant within the same app
- Traditional multi-page navigation is acceptable — this does **not** need to be a zero-reload SPA
- Tenant admin console requires:
  - Extension / user management
  - **Visual IVR / call-flow builder**: drag-and-drop, node-based canvas, React-Flow-like interaction model, but implemented natively in Flutter (not by embedding React Flow)
  - **Real-time call monitoring**: barge, whisper, live listen, extension presence — all gated behind granular, role-based permissions

---

## 10. Security & Permissions Model

- Permissions are granular and role-aware, not just role-based on/off switches. Examples requiring granular control:
  - Call recording access (per tenant, per extension/agent)
  - Real-time monitoring capabilities (barge/whisper/listen) — who can do this to whom
  - Reseller visibility into tenant config/admin data (yes) vs. private data like recordings/CDRs (no)
- Master has unrestricted visibility across the entire platform (support/operations necessity).
- Tenant data isolation is enforced both at the FreeSWITCH domain layer and at the application/database layer (tenant ID scoping on every query).

---

## 11. Suggested Implementation Phasing

This is a starting point for task breakdown — not a rigid roadmap. The refined, staged plan is in [`plan/implementation-plan.md`](plan/implementation-plan.md).

**Phase 1 — Foundation**
- Tenant/Org Management + Identity & Permissions services
- Basic FreeSWITCH multi-domain provisioning (manual/scripted, one node)
- Basic OpenSIPs routing config
- MariaDB schema for orgs, users, extensions, trunks

**Phase 2 — Core Telephony**
- Trunk/Carrier Config Service
- Core PBX features in FreeSWITCH: queues, ring groups, auto attendants, hunt groups, call parking
- CDR ingestion + CDR/Billing API Service (read-only export first)

**Phase 3 — Console MVP**
- Flutter console: auth, role-based navigation, extension/user management
- Basic call-flow/IVR builder (canvas MVP, limited node types)

**Phase 4 — HA & Scale**
- Multi-node FreeSWITCH deployment
- Redis call-ownership registry + active-active failover
- OpenSIPs load balancing across nodes

**Phase 5 — Recording, Voicemail, Monitoring**
- Recording Service + per-tenant S3 storage + granular permissions
- Voicemail Service (email delivery, optional transcription integration)
- Real-time monitoring (barge/whisper/listen) in console

**Phase 6 — Full UC**
- Native video conferencing (FreeSWITCH)
- XMPP chat/presence microservice + console integration

**Phase 7 — Extended Features**
- T.38 fax service
- SMS-for-DID service
- Analytics/reporting dashboards, call center wallboards

**Phase 8 — Future**
- Automatic hard-phone device provisioning

---

## 12. Open Questions for Implementation

- Container orchestrator: Kubernetes vs. Docker Swarm/Nomad — not yet decided
- Exact CDR/Billing API schema/spec — not yet defined
- Choice of cloud speech-to-text provider for voicemail transcription — not yet decided
- Specific XMPP server implementation (e.g., ejabberd, Prosody, Openfire) — not yet decided

Additional questions and gaps found while breaking this down are tracked in [`decisions.md`](decisions.md).

---

## 13. Reference Glossary

- **Master** — the platform operator: top of the hierarchy, full platform visibility, provisions resellers. Completely unbranded, with no name, logo, or theme on any surface.
- **Reseller / Agent** — white-labeled partner who provisions and owns their own tenants
- **Tenant** — end customer organization, brings its own carrier trunk
- **Domain-based multi-tenancy** — one subdomain per tenant via FreeSWITCH's native multi-domain support
- **Active-active failover** — any FreeSWITCH node can serve any tenant; Redis tracks call ownership for failover routing
