# Feature parity: NetSapiens and Metaswitch

Where ConductorUC stands against the two products it is measured against, and the order features are built in. Built status comes from [status.md](status.md), which is judged from the code.

**Sources and limits.** The competitor columns come from what each vendor publicly documents about its hosted-PBX and carrier products (NetSapiens SNAPsolution / ns-api; Metaswitch MetaSphere EAS, CommPortal, Perimeta SBC, Sentinel). No vendor system was available to check against, so treat a competitor cell as "offered", not as a statement of how well. Metaswitch is a carrier-class IMS and SBC portfolio as well as a hosted PBX; this platform is a hosted PBX, so parity with Metaswitch here means its hosted-business feature set, not its IMS core, lawful intercept, or mobile-core products (see "Out of scope").

Legend: **Built** exists with tests. **Partial** some of it. **Planned** in the [implementation plan](implementation-plan.md), not built. **Gap** in neither. Priority: P1 next, P2 after that, P3 later.

## 1. Tenancy, branding, administration

| Capability | NetSapiens | Metaswitch | Here | Priority |
|---|---|---|---|---|
| Reseller and customer hierarchy, white label | Yes (reseller, domain) | Yes (service provider, enterprise) | Built | |
| Per-reseller portal hostname and brand | Yes | Yes | Built | |
| Sites or departments inside a customer | Yes | Yes | Gap | P2 |
| Feature packages / class of service per customer | Yes (dial plan, permissions, "scopes") | Yes (service profiles) | Gap | P2 |
| Role-based admin with granular permissions | Yes (scopes) | Yes | Built (grants) | |
| API keys for integrations | Yes | Yes | Planned (S1-08, G-14) | P2 |
| REST API for every function | Yes | Yes | Partial (console API only, no API-key access) | P2 |
| Audit trail | Yes | Yes | Partial (G-15) | P2 |
| Bulk import of users and numbers (CSV) | Yes | Yes | Gap | P2 |

## 2. Subscriber calling features

| Capability | NetSapiens | Metaswitch | Here | Priority |
|---|---|---|---|---|
| Extensions, SIP credentials, password reset | Yes | Yes | Built | |
| Do not disturb | Yes | Yes | Gap | **P1** |
| Call forwarding: always, busy, no answer, unreachable | Yes | Yes | Gap | **P1** |
| Simultaneous ring (own mobile, other numbers) | Yes | Yes | Gap | **P1** |
| Sequential ring / find me follow me | Yes ("answering rules") | Yes | Gap | P2 |
| Time-of-day rules for the above | Yes (time frames) | Yes | Partial (schedules exist, not applied to extensions) | P2 |
| Selective call accept / reject, anonymous call rejection | Yes | Yes | Gap | P2 |
| Caller ID name and number policy, block | Yes | Yes | Partial (caller-ID resolution built; no per-user block) | P2 |
| Call waiting, hold, transfer, 3-way | Phone / switch | Phone / switch | Handled by phone and FreeSWITCH | |
| Call park and retrieve | Yes | Yes | Built (parking lots) | |
| Call pickup (directed and group) | Yes | Yes | Gap | P2 |
| Intercom and paging (groups, overhead) | Yes | Yes | Gap | P2 |
| Speed dial | Yes | Yes | Gap | P3 |
| Busy lamp field, presence, shared line appearance | Yes | Yes | Gap (planned with the realtime layer) | P2 |
| Hot desking / login to any phone | Yes | Yes | Gap | P3 |
| Voicemail: boxes, greetings, PIN, retrieval | Yes | Yes | Built | |
| Voicemail to email with attachment | Yes | Yes | Planned (S5-07) | **P1** |
| Voicemail transcription | Yes | Yes | Planned (S5-06) | P2 |
| Message waiting indicator | Yes | Yes | Partial (event has no consumer, G-42) | P2 |
| Call history and click to dial for the user | Yes | Yes | Gap | P2 |
| Contacts / directory (company, personal) | Yes | Yes | Gap | P3 |

## 3. Group and business features

| Capability | NetSapiens | Metaswitch | Here | Priority |
|---|---|---|---|---|
| Auto attendant / IVR with schedules | Yes | Yes | Built (call flows, schedules) | |
| Ring groups / hunt groups | Yes | Yes | Built | |
| Call queues, agents, tiers | Yes (call center) | Yes | Built | |
| Queue reporting and wallboards | Yes | Yes | Planned (S7-05..07) | P2 |
| Supervisor listen, whisper, barge | Yes | Yes | Planned (S5-09) | P2 |
| Audio conferencing, PIN | Yes | Yes | Built | |
| Web / video conferencing | Yes | Yes | Planned (S6-01) | P3 |
| Call recording, on demand and by policy | Yes | Yes | Planned (S5-01..05) | **P1** |
| Attendant / receptionist console | Yes | Yes | Gap | P3 |
| Executive-assistant / boss-secretary | Yes | Yes | Gap | P3 |
| Music on hold and prompts | Yes | Yes | Built (media) | |
| Fax to email and email to fax | Yes | Yes | Planned (S7-01, S7-02) | P2 |
| SMS / MMS on numbers | Yes | Yes | Planned (S7-03, S7-04) | P2 |
| Team chat and presence | Yes (UC client) | Yes (MaX UC) | Planned (S6-03..07) | P3 |

## 4. Clients and devices

| Capability | NetSapiens | Metaswitch | Here | Priority |
|---|---|---|---|---|
| Admin portal | Yes | Yes | Built (console) | |
| End-user self-service portal (settings, voicemail, history) | Yes | Yes (CommPortal) | Gap: the console is admin-oriented | **P1** |
| Web softphone (WebRTC) | Yes | Yes | Gap | P2 |
| Mobile apps | Yes | Yes | Gap | P3 |
| Auto-provisioning of desk phones | Yes | Yes | Partial (Yealink only) | P2 |
| More vendors (Polycom, Snom, Grandstream, Cisco) | Yes | Yes | Planned (S8-02) | P2 |
| Zero-touch redirection | Yes | Yes | Planned (S8-03) | P3 |
| SIP over TLS, SRTP | Yes | Yes | Partial (TLS built, SRTP deferred by the owner) | P2 |

## 5. Trunking, routing, numbers

| Capability | NetSapiens | Metaswitch | Here | Priority |
|---|---|---|---|---|
| SIP trunks: registration and IP authenticated | Yes | Yes (Perimeta) | Built | |
| Outbound route plans with failover | Yes | Yes | Built (API; no console screen) | P1 |
| Least-cost routing, rate tables | Yes | Yes | Gap | P3 |
| Number normalization and translation | Yes | Yes | Partial (E.164 handling in dialplan) | P2 |
| DID inventory and assignment | Yes | Yes | Built | |
| Number porting workflow | Yes (via partners) | Yes | Gap | P3 |
| Emergency calling: location, routing, notification | Yes | Yes | Partial (G-1) | P2 |
| Toll-fraud limits | Yes | Yes | Built | |
| STIR/SHAKEN attestation | Yes | Yes | Gap (carrier-dependent) | P3 |
| SBC functions: topology hiding, transcoding, DoS protection | Via partner SBC | Yes (Perimeta) | Partial (OpenSIPs edge, rate limits, neutral headers) | P3 |

## 6. Reporting, billing, operations

| Capability | NetSapiens | Metaswitch | Here | Priority |
|---|---|---|---|---|
| CDR with search and export | Yes | Yes | Built (API and export; no console screen) | **P1** |
| Billing integration (rating feed) | Yes | Yes | Partial (billing records API) | P2 |
| Usage and analytics dashboards | Yes | Yes | Planned (S7-05) | P2 |
| High availability, geo-redundancy | Yes | Yes | Planned (S4) | P2 |
| Monitoring and alarms | Yes | Yes | Partial (platform health screen) | P2 |
| Backups and restore runbook | Yes | Yes | Gap (release readiness) | P2 |

## Out of scope

Metaswitch sells an IMS core (Clearwater), a mobile packet core and lawful-intercept gear. None of that is part of a hosted PBX, and none is planned here. Lawful intercept is a regulatory obligation of the operator that a hosted PBX supports only by exposing recording and CDR data, which the first tranche below provides.

## Build order

The first tranche closes the gaps a customer notices on day one of a pilot and that NetSapiens and Metaswitch both treat as basic.

| Tranche | What | Why first |
|---|---|---|
| 1a | Per-extension call handling: do not disturb, forward always, busy, no answer, unreachable, simultaneous ring | The most used subscriber feature after voicemail. Fits the design: the directory lookup already carries call-forward settings ([03 §3.1](../architecture/03-signaling-and-media.md)). |
| 1b | Voicemail to email, and a console voicemail screen (messages, listen, delete) | Voicemail without email is not usable for most customers. Notification templates already exist. |
| 1c | Console screens for what has an API and no screen: CDR search and export, outbound routes | Removes "API only" gaps with no new back end. |
| 1d | Call recording (S5-01 to S5-05) | Largest single missing feature. Needs the storage and node uploader work, so it comes after 1a to 1c. |
| 1e | End-user self-service portal: a person signs in and sees only their own settings, voicemail and history | Turns 1a and 1b into something end users reach without an administrator. |
| 2 | Sequential ring and answering rules by schedule, call pickup, paging, BLF and presence, more phone vendors, WebRTC softphone, fax, SMS, wallboards, sites and feature packages, API keys | Depends on the realtime layer (S5-08) or on tranche 1. |
| 3 | Video, chat, mobile apps, zero-touch, least-cost routing, porting, attendant console | Large, and least likely to block a pilot. |

Each item becomes plan tasks under the existing stages when it starts; the status file is updated as they land.
