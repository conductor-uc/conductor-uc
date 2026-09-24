# 01 — System overview

## 1. Context

```mermaid
flowchart LR
  subgraph Endpoints["Customer endpoints (BYO)"]
    Phones["SIP hard phones / softphones"]
    XMPPc["XMPP clients"]
  end
  Carriers["Tenant-owned SIP trunks (carriers)"]
  Browser["Admin console (browser)"]
  Billing["External billing platforms"]
  SMSc["Carrier SMS APIs"]
  STT["Cloud speech-to-text"]
  SMTP["SMTP relay"]

  Platform(["Platform"])

  Phones <-- SIP/RTP --> Platform
  XMPPc <-- XMPP --> Platform
  Carriers <-- SIP/RTP --> Platform
  Browser <-- HTTPS/WSS --> Platform
  Billing -- HTTPS API --> Platform
  Platform <-- HTTPS --> SMSc
  Platform -- HTTPS --> STT
  Platform -- SMTP --> SMTP
```

## 2. Container view

```mermaid
flowchart TB
  subgraph Edge
    OS["OpenSIPs cluster<br/>registrar · auth · trunk edge · LB · topology hiding · presence"]
    GW["api-gateway<br/>HTTPS + WSS"]
    XMPP["XMPP server"]
  end

  subgraph Media["Media tier (stateless, any node serves any tenant)"]
    FS1["FreeSWITCH node 1"]
    FS2["FreeSWITCH node N"]
  end

  subgraph Telephony["Telephony integration"]
    TC["telephony-config<br/>mod_xml_curl + OpenSIPs projection"]
    CC["call-control<br/>ESL bridge + call registry"]
  end

  subgraph Domain["Domain services (Node.js / TypeScript)"]
    ORG[org-service]
    IDN[identity-service]
    PBX[pbx-config-service]
    TRK[trunk-service]
    CF[callflow-service]
    CDR[cdr-service]
    REC[recording-service]
    VM[voicemail-service]
    NTF[notification-service]
    CHAT[chat-service]
    AN[analytics-service]
    SMS[sms-service]
    FAX[fax-service]
  end

  subgraph Data
    DB[(MariaDB)]
    R[(Redis)]
    BUS[(NATS JetStream)]
    S3[(S3-compatible storage)]
  end

  OS <--> FS1 & FS2
  FS1 & FS2 -- xml_curl --> TC
  CC -- ESL --> FS1 & FS2
  FS1 & FS2 -- json_cdr --> CDR
  TC -- writes projection --> DB
  OS -- reads projection --> DB
  OS -- affinity lookups --> R
  CC --> R
  GW --> Domain
  Domain --> DB
  Domain <--> BUS
  CC <--> BUS
  TC <--> BUS
  REC & VM & FAX & CF --> S3
```

### Tiers

| Tier | Contents | State |
|---|---|---|
| Edge | OpenSIPs, api-gateway, XMPP server | OpenSIPs holds registrations and dialogs, replicated inside its cluster |
| Media | FreeSWITCH nodes | **Stateless apart from live calls.** All config comes from `telephony-config`, all persistent media goes to S3 |
| Telephony integration | `telephony-config`, `call-control` | The only services that talk to FreeSWITCH or OpenSIPs directly |
| Domain | Business microservices | Each owns its own database schema |
| Data | MariaDB, Redis, NATS, S3 | Redis is ephemeral; MariaDB and S3 are the systems of record |

## 3. Key architectural principles

1. **FreeSWITCH nodes are cattle.** A node holds nothing that must outlive a call: no local directory, dialplan, voicemail, prompts, or recordings. Any node can be replaced without data loss. This is what makes active-active work ([03](03-signaling-and-media.md), [04](04-high-availability.md)).
2. **Two telephony integration services own all SIP/media knowledge.** Domain services never generate FreeSWITCH XML or OpenSIPs rows. They publish domain events, and `telephony-config` projects those events into switch-readable form.
3. **Tenant scoping is enforced at every layer:** the SIP domain in OpenSIPs and FreeSWITCH, the `tenant_id` column in every tenant-owned table, and the authorization check at every API.
4. **Nothing user-facing is branded except by a reseller.** See [02 §5](02-tenancy-and-branding.md#5-branding).
5. **Services are independently deployable** and communicate over REST (synchronous, OpenAPI-described) or events on NATS JetStream (asynchronous, via a transactional outbox).

## 4. Principal flows

### 4.1 Extension registration

```mermaid
sequenceDiagram
  participant P as Phone (ext 101 @ acme.base.example)
  participant O as OpenSIPs
  participant D as MariaDB (opensips projection)
  P->>O: REGISTER sip:acme.base.example
  O-->>P: 401 challenge (realm = acme.base.example)
  P->>O: REGISTER + Authorization
  O->>D: subscriber lookup (username, domain) → HA1
  O-->>P: 200 OK (contact stored in usrloc, cluster-shared)
```

A phone may connect to a **SIP proxy hostname** (`sip.<reseller base domain>`, or `sip.<platform base domain>` for direct tenants) as an outbound proxy while it registers to, and authenticates against, the tenant's domain above. The proxy name only decides which TLS certificate the phone sees; see [03 §2.3](03-signaling-and-media.md#23-sip-over-tls).

### 4.2 Inbound call from a tenant trunk

```mermaid
sequenceDiagram
  participant C as Carrier (tenant trunk)
  participant O as OpenSIPs
  participant F as FreeSWITCH (any node)
  participant T as telephony-config
  participant R as Redis
  participant CC as call-control
  C->>O: INVITE to DID +15551234567
  O->>O: Identify trunk (source IP / registrant) → tenant
  O->>R: Target a pinned resource? (conference/queue/park affinity)
  O->>F: INVITE (X-Tenant-Id, X-Trunk-Id) via dispatcher
  F->>T: xml_curl dialplan(context=from-trunk, DID)
  T-->>F: XML: set vars, run flow_runner.lua(flow version)
  F-->>CC: ESL CHANNEL_CREATE / ANSWER
  CC->>R: HSET call:{uuid} node=F tenant=...
  F->>O: INVITE to ext 101 (via OpenSIPs for location lookup)
  O->>O: usrloc lookup → phone contact
```

### 4.3 Configuration change

```mermaid
sequenceDiagram
  participant UI as Console
  participant GW as api-gateway
  participant PBX as pbx-config-service
  participant BUS as NATS
  participant T as telephony-config
  participant O as OpenSIPs
  UI->>GW: POST /v1/tenants/{t}/extensions
  GW->>PBX: forward (authz checked)
  PBX->>PBX: tx: insert extension + outbox event
  PBX-->>BUS: pbx.extension.created
  BUS-->>T: consume
  T->>T: upsert opensips.subscriber, invalidate xml_curl cache
  T->>O: MI reload (if needed)
```

## 5. Monorepo layout

```
apps/
  console/                  Flutter web console (Dart)
services/
  api-gateway/
  org-service/
  identity-service/
  pbx-config-service/
  trunk-service/
  callflow-service/
  telephony-config/
  call-control/
  cdr-service/
  recording-service/
  voicemail-service/
  notification-service/
  chat-service/
  analytics-service/
  sms-service/
  fax-service/
  provisioning-service/     (Stage 8)
packages/                   Shared TypeScript libraries, published as @cuc/*
  config/  logger/  http/  db/  events/  authz/  audit/  crypto/
  storage/  testing/  api-contracts/  callflow-ir/
telephony/
  freeswitch/               Image, base XML, Lua (flow_runner, voicemail, uploader)
  opensips/                 Image, opensips.cfg templates, DB schema version pin
infra/
  compose/                  Local development stack
  deploy/                   Production manifests (after the orchestrator decision)
tests/
  sip/                      SIPp scenarios + harness
  e2e/                      Cross-service end-to-end tests
tools/
  brand-leak/               Forbidden-string scanner
  gen/                      Service & client generators
docs/
```

Tooling **(Proposed, D-001)**: pnpm workspaces and Turborepo for the TypeScript packages, with the Flutter app built by its own toolchain from CI. Each service builds a single container image.
