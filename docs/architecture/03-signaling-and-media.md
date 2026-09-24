# 03 — Signaling & media

## 1. Division of responsibility

| Concern | OpenSIPs (edge) | FreeSWITCH (media/app) | Platform services |
|---|---|---|---|
| Phone registration & digest auth | **Owns** (registrar, `auth_db`, `usrloc` full-sharing cluster) | — | `telephony-config` projects subscribers |
| Location lookup for calls to phones | **Owns** | Sends the call back through OpenSIPs | — |
| Trunk registration to carriers | **Owns** (`uac_registrant`, clustered) | — | Projection from `trunk-service` |
| Trunk auth for outbound calls | **Owns** (`uac_auth`) | — | Same |
| Inbound trunk identification | **Owns** (`permissions` address table + registrant contact match) | — | Same |
| Choosing a trunk for an outbound call (LCR among the tenant's trunks) | **Owns** (`drouting`, one rule group per tenant) | — | Same |
| Load balancing across FS nodes | **Owns** (`dispatcher` with OPTIONS probing) | — | — |
| Pinned resources (conference, queue, park) | Looks up affinity in Redis (`cachedb_redis`) | — | `call-control` manages leases |
| Topology hiding | **Owns** (`topology_hiding`) | — | — |
| Extension BLF / dialog presence | **Owns** (`presence`, `pua_dialoginfo`) | Publishes park-slot state | — |
| IVR, call flows, ring/hunt groups | — | **Owns** (Lua flow runner) | `callflow-service` serves IR |
| Queues, parking, conferences, video MCU | — | **Owns** (`mod_callcenter`, `mod_valet_parking`, `mod_conference`) | Config via `telephony-config` |
| Voicemail | — | Records and plays (Lua) | `voicemail-service` stores |
| Recording | — | Records to a transient spool | `recording-service` stores |
| CDRs | — | `mod_json_cdr` POSTs | `cdr-service` ingests |
| Fax | — | `mod_spandsp` (T.38 / G.711 passthrough) | `fax-service` |

Why OpenSIPs owns registration and trunks **(Proposed, D-007)**: FreeSWITCH nodes are interchangeable. If phones registered to a specific FS node, calls routed through any other node could not reach them. If each FS node ran Sofia gateways, every node would register every tenant trunk, which many carriers reject or handle badly. Centralizing both in the OpenSIPs cluster keeps FS stateless.

## 2. OpenSIPs

- Version: OpenSIPs 3.6 (the image is `opensips/opensips:3.6`, schema vendored from 3.6.8). Configuration is a templated `opensips.cfg` rendered at container start from environment variables. There are no per-tenant edits to the config file; everything tenant-specific lives in DB tables.
- DB backend: `db_mysql` against a dedicated `opensips` schema in MariaDB. **Only `telephony-config` writes to that schema** (the projection pattern). OpenSIPs reads it and caches it, and reloads are triggered through MI (`mi_http`) after projection updates: `dr_reload`, `address_reload`, `domain_reload`, `reg_reload`, `ds_reload`, and `tls_reload` for certificates.
- Modules in scope: `registrar`, `usrloc`, `auth`, `auth_db`, `domain`, `permissions`, `dispatcher`, `drouting`, `uac`, `uac_auth`, `uac_registrant`, `dialog`, `topology_hiding`, `nathelper`, `presence`, `presence_dialoginfo`, `pua_dialoginfo`, `cachedb_redis`, `tls_openssl`, `tls_mgm`, `proto_tls`, `clusterer`, `proto_hep` (HEP export to Homer). As built, `clusterer` is not loaded yet and HEP export is not enabled (see `opensips.cfg.template`).
- Header discipline: OpenSIPs strips any inbound `X-Tenant-*` or `X-Trunk-*` headers from external sources. It then sets `X-Tenant-Id`, `X-Tenant-Domain`, `X-Trunk-Id`, and `X-Call-Direction` on the leg toward FS. FS accepts calls only from OpenSIPs addresses (a Sofia ACL).
- NAT: `nathelper` for signaling (`fix_nated_contact`, keepalive pinging). Media NAT is handled by FreeSWITCH (`NDLB`/auto-NAT). Media anchoring at the edge with RTPengine is deferred (O-7), which means FS media IPs are visible in SDP until then.

### 2.1 Routing logic (summary)

```
request from trunk (source matched in address table or registrant):
    tenant := trunk.tenant
    if DID maps to a pinned resource -> route to affinity node
    else -> ds_select_dst(set=fs_nodes, alg=least-loaded/hash-callid)
request from registered phone (authenticated in its domain):
    if R-URI is in same domain & is a local extension that is registered and
       the call is "simple ext->ext" -> still send to FS (features: recording,
       call forwarding, voicemail on no-answer live in FS)
    else -> FS via dispatcher
request from FS:
    if destination is a local user -> lookup(location) and relay
    if destination is external     -> do_routing(group = tenant's dr group)
                                     uac_auth with trunk creds; failover to next gw on 5xx/timeout
```

All calls, including extension-to-extension calls, pass through FreeSWITCH so that recording, forwarding, voicemail-on-no-answer, and CDRs apply consistently. The cost is some extra media hops. That's an accepted trade-off in v1.

### 2.2 Presence / BLF (S2-17)

Extension BLF is `presence` + `presence_dialoginfo` + `pua_dialoginfo`, all DB-backed against the same `opensips` schema every other stateful module here uses (`presence-create.sql`: `presentity`, `active_watchers`). No application service is involved — `pua_dialoginfo` registers its own dialog callbacks the moment it loads, and the existing `dialog.so`/`topology_hiding()` pairing (already in route{} for every dialog-forming request) is what creates the dialog it watches; there was nothing to add on the publish side.

The only new routing logic is the SUBSCRIBE handler: digest-authenticated the same way REGISTER is, then a same-domain check (watcher's From domain must equal the presentity's To domain) before `handle_subscribe()` — SIP has no `dataClass`/`permission` mechanism of its own, but the platform's tenant-scoping rule (CLAUDE.md rule 2) still applies at this edge the same as everywhere else tenant state is read, so one tenant's phone can never watch another tenant's extension state.

"Publishes park-slot state" (§1's table) is **not yet implemented** — it's S2-14's (call parking) forward reference, added when that task's own park-lot state exists to publish. S2-17 covers ordinary extension-to-extension BLF only.

See `docs/decisions.md` G-38 for what this task could verify live (config parses, every presence/pua module reaches clean `mod_init`) versus what needs a real call in flight to confirm (actual NOTIFY delivery across early/confirmed/terminated) — left for issue #44's SIP regression suite, per this repo's standing practice for FS/OpenSIPs-facing behavior.

### 2.3 SIP over TLS

| Item | Behaviour |
|---|---|
| Listener | `tls:*:5061` (`OPENSIPS_TLS_PORT`), alongside UDP and TCP on 5060. TLS 1.2 is the floor; weak ciphers are refused. Clients are not asked for a certificate; phones authenticate with digest. |
| On/off | The entrypoint keeps the TLS blocks of the template when `OPENSIPS_TLS_CERT_FILE` is set or `OPENSIPS_TLS_ENABLED=true`; otherwise there is no 5061 listener. |
| Certificates | `tls_mgm` runs in **database mode**: one server row (`type` 2) per SIP proxy hostname, chosen by the name the client asks for (SNI, `match_sip_domain`). A `default` row answers an unknown or missing name. `telephony-config` is the only writer (`certificate-sync`). |
| Reload | On `org.certificate.issued` and on a periodic reconcile, telephony-config rewrites changed rows, removes rows for withdrawn certificates, and calls `tls_reload` over MI. No restart. |
| File fallback | `OPENSIPS_TLS_CERT_FILE` / `OPENSIPS_TLS_KEY_FILE` add a `filedefault` certificate for names the database has nothing for, and for the time before the first certificate is issued. |
| Development | `OPENSIPS_TLS_DEV_SELF_SIGNED=true` makes a self-signed certificate for `OPENSIPS_TLS_DEV_NAMES` (default `platform.test,*.platform.test`) when the file is missing. Not for production: no phone trusts it. |
| Not built | SRTP (encrypted media). |

The private key sits in clear in the `opensips` schema, because that is how OpenSIPs loads it from the database. org-service's encrypted copy stays the source of truth, so restrict access to that schema accordingly.

## 3. FreeSWITCH

- Version: FreeSWITCH 1.10.x. The image is built from `telephony/freeswitch` and loads only the required modules.
- Required modules: `mod_sofia`, `mod_xml_curl`, `mod_event_socket`, `mod_json_cdr`, `mod_lua`, `mod_curl`, `mod_http_cache`, `mod_dptools`, `mod_commands`, `mod_callcenter`, `mod_valet_parking`, `mod_conference`, `mod_spandsp`, `mod_sndfile`, `mod_tone_stream`, `mod_local_stream` (MOH), and codecs (`mod_opus`, G.711, G.722, `mod_vpx` and `mod_av` for video).
- **Profiles:** a single `internal` Sofia profile that receives only from OpenSIPs. It has no gateways and no registrations. Its brand-neutral params are `user-agent-string` and `username` (the SDP `o=` line), plus a neutral `s=` session name.
- **Config delivery (D-006):** `mod_xml_curl` bindings `directory`, `dialplan`, and `configuration` point at `telephony-config`, reached through a node-local caching proxy (or FS's own XML cache with a TTL). Static bootstrap XML contains only node identity, ACLs, and the xml_curl URLs.
- **Event socket:** `mod_event_socket` listens on a private interface. `call-control` connects inbound to every node.

### 3.1 xml_curl endpoints (`telephony-config`)

| Binding | Section/purpose | Key inputs | Response |
|---|---|---|---|
| `directory` | User lookup for features (voicemail box, call forward, caller ID, recording policy flags) | `domain`, `user` | `<domain><user>` with params and variables. No password auth, because OpenSIPs already authenticated the call. |
| `dialplan` | Routing decisions | `Caller-Context`, `Destination-Number`, `variable_sip_h_X-Tenant-Id`, and so on | A small extension that sets channel variables and runs `flow_runner.lua` or a builtin app |
| `configuration` | `callcenter.conf` (queues/agents/tiers), `conference.conf` (profiles), `valet_parking.conf` | `key_value` | Module config filtered to resources assigned to this node (see affinity) |

Performance targets: p99 below 20 ms for directory and dialplan lookups at 200 requests/s per FS node. Responses for immutable data (published flow versions) are cacheable indefinitely. Everything else carries a short TTL (≤ 30 s) plus explicit purge on change events (`xml_flush_cache` sent via `call-control`).

### 3.2 Dialplan contexts per call

| Context | Entered when | Dialplan behavior |
|---|---|---|
| `from-trunk` | `X-Call-Direction: inbound` | DID → destination (flow, extension, ring group, queue, conference, fax) |
| `from-ext` | Call from a registered phone | Feature codes, extension dialing, outbound (sent to OpenSIPs with `X-Tenant-Id`) |
| `internal-app` | Transfers or originates by `call-control` | Monitor/eavesdrop, park retrieval, conference join |

Tenant data is never inferred from the context name. It always comes from the trusted `X-Tenant-Id` header or channel variable.

## 4. Call flows (IVR / auto attendant)

**(Proposed, D-008)**: visual flows are compiled into a versioned **intermediate representation (IR)** that a generic Lua interpreter executes on the FS node.

- The console edits a **graph** (nodes, ports, edges, positions). See [08 §4](08-console.md#4-call-flow-builder).
- `callflow-service` validates the graph and, on publish, compiles it to IR (`@cuc/callflow-ir`, JSON, schema-versioned). Published versions are immutable.
- The dialplan response for a DID or entry point sets `flow_id` and `flow_version` and runs `flow_runner.lua`.
- `flow_runner.lua` fetches the IR from `callflow-service` (via `mod_curl`) and caches it on local disk keyed by `flow_id@version`. Because published versions are immutable, the cache never needs invalidation.
- **Loop guard:** each call carries a step counter. If it exceeds the maximum (default 200 steps), the runner falls back to a configured hangup or to the operator extension.
- Media references in the IR are asset IDs. Playback URLs resolve to `http_cache://` URLs that the node caches locally.

IR sketch:

```json
{
  "irVersion": 1,
  "flowId": "0190…",
  "version": 7,
  "entry": "n1",
  "nodes": {
    "n1": { "type": "time_condition", "scheduleId": "…", "out": { "open": "n2", "closed": "n5" } },
    "n2": { "type": "menu", "promptAssetId": "…", "timeoutMs": 5000, "maxRetries": 3,
            "out": { "1": "n3", "2": "n4", "timeout": "n2", "invalid": "n2", "exhausted": "n5" } },
    "n3": { "type": "ring_group", "ringGroupId": "…", "out": { "no_answer": "n5" } },
    "n4": { "type": "queue", "queueId": "…", "out": { "exit": "n5" } },
    "n5": { "type": "voicemail", "mailboxId": "…" }
  }
}
```

Node types, by stage:

| Stage | Node types |
|---|---|
| MVP (S2/S3) | `play`, `menu`, `time_condition`, `extension`, `ring_group`, `queue`, `voicemail`, `goto_flow`, `hangup`, `set_caller_id_name_prefix` |
| Later | `conference`, `dial_external`, `http_lookup` (webhook routing), `language`, `record_message`, `fax_detect`, `directory` (dial-by-name) |

## 5. Stateless-node rules for features

| Feature | Where state lives | Cross-node strategy |
|---|---|---|
| Directory, dialplan, config | `telephony-config` | Fetched per call |
| Prompts, MOH, greetings | S3 via media assets | `http_cache` on the node (a disposable cache) |
| Voicemail messages | S3 + `voicemail-service` DB | A Lua voicemail app records to the spool, then uploads (D-009). Retrieval works from any node. |
| Recordings | S3 | Spool, then upload, then delete locally (D-011) |
| Ring / hunt groups | None (per call) | No affinity needed |
| Queues (`mod_callcenter`) | In memory, per node | **Affinity:** each queue is leased to one node at a time ([04](04-high-availability.md)) |
| Call parking (`mod_valet_parking`) | In memory, per node | **Affinity** per parking lot |
| Conferences / video rooms | In memory, per node | **Affinity** per active room |
| MWI | `voicemail-service` | Sent as NOTIFY via OpenSIPs presence (message-summary) |
| BLF | OpenSIPs dialog state | Native at the edge |

## 6. Recording pipeline (summary)

1. At call setup, the dialplan response includes the recording decision, evaluated by `recording-service` policy (cached in `telephony-config`).
2. FS runs `record_session` into `/var/spool/cuc/rec/{uuid}.{ext}` on tmpfs or local ephemeral disk.
3. On `RECORD_STOP`, the node-local uploader sidecar (`telephony/freeswitch/uploader`) PUTs the file to the tenant bucket through a presigned URL obtained from `recording-service`, verifies the checksum, and deletes the local file.
4. The uploader retries with backoff. Files older than N hours that are still not uploaded raise an alert. A node that dies before upload loses the in-flight recording (accepted in v1, O-13).

"Recordings are never stored on FreeSWITCH nodes" is interpreted as: **there is no durable storage on nodes**. A transient spool is unavoidable and is bounded in size and age.

## 7. Emergency calling

The SAD does not cover emergency calling. See gap G-1 in [decisions.md](../decisions.md). At minimum the dialplan MUST allow direct dialing of emergency numbers without a prefix, route them to the tenant's designated trunk with top priority, and fire a notification hook. The details depend on the regulatory scope decision.
