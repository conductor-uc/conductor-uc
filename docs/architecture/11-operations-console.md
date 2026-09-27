# 11. Operations console

The master's view into the running platform: every service, the FreeSWITCH nodes, the SIP edge, the event bus and the data stores. The master can also act on the media nodes: drain one, return it, or change its weight. It replaces S3-05's Platform health page, which only asked eight services whether they were ready. Decisions are in [G-124](../decisions.md); the plan tasks are S4-12 (live state) and S4-13 (history).

It is a master tier screen, so it is unbranded like the rest of the master console (CLAUDE.md rule 1), and nothing in it is a tenant's private data: it counts calls, it never lists their parties.

## 1. Access

| Permission | Class | Held by | Allows |
|---|---|---|---|
| `platform.observe` | config | master_admin, master_support | reading everything below |
| `platform.operate` | config | master_admin | drain, undrain, set weight |

Both are master-only under hard rule H3 (07 §3.1), like the reseller lifecycle permissions: no role or grant can give them to a reseller or tenant actor. Every action writes an audit event (`platform.node.drained`, `.undrained`, `.weight_changed`) with the actor, in the same transaction as the domain event.

## 2. Live state (S4-12)

### 2.1 Sources

| Area | Asked | How |
|---|---|---|
| Services | each service's `GET /internal/v1/status` (service token) | `@cuc/http` serves it on every service: version, uptime, readiness checks by name, memory; a service adds sections, such as its outbox backlog (`@cuc/events`: pending, oldest pending age, given up) |
| Media nodes | call-control | `fsnode:{id}` now keeps what FreeSWITCH's `HEARTBEAT` says (sessions, max sessions, idle CPU, sessions per second, uptime); drain state, calls and leases as in S4-02 |
| Dispatcher | telephony-config `GET /internal/v1/opensips/status` | MI `ds_list` for each destination's state, the `dispatcher` table for its weight, MI `get_statistics` for registrations, dialogs, transactions and shared memory, MI `uptime` |
| Event bus | the gateway's own NATS connection | JetStream streams (messages, bytes) and every durable consumer's pending, awaiting ack and redelivered counts |
| Redis | the gateway's own Redis connection | `INFO` |
| MariaDB | telephony-config (it already holds a connection) | `SHOW GLOBAL STATUS`, `VERSION()` |
| NATS server | the gateway's NATS connection | server info |

Services the gateway does not otherwise call (media-worker, notification-service, each node's recording uploader) are listed in its `PLATFORM_STATUS_TARGETS` (`name=url`, comma-separated).

A source that does not answer within 2 s is shown as unreachable; the rest of the page still loads.

### 2.2 API (through the gateway)

`GET /v1/platform/overview` (`platform.observe`), served by the gateway itself:

```jsonc
{
  "checkedAt": "2026-09-27T22:00:00.000Z",
  "services": [{
    "name": "call-control", "status": "up",          // up | degraded | down
    "latencyMs": 4, "version": "0.1.0", "uptimeSeconds": 8123,
    "checks": [{ "name": "redis", "status": "pass" }],
    "memory": { "rssBytes": 91234304, "heapUsedBytes": 40123000 },  // or null
    "outbox": { "pending": 0, "oldestPendingSeconds": null, "failed": 0 },  // or null
    "facts": []   // anything else it reports, as for data stores (an uploader: its spool)
  }],
  "nodes": [{
    "nodeId": "freeswitch-2", "status": "draining",  // up | draining | down
    "draining": true, "calls": 3, "leases": 0,
    "weight": 1,                                      // null: no dispatcher row names it
    "dispatcher": "inactive",                         // active | inactive | probing | absent
    "uri": "sip:freeswitch-2:5060",
    "sessions": 6, "maxSessions": 1000, "cpuIdlePercent": 97.3,
    "sessionsPerSecond": 0, "uptimeSeconds": 8200,    // null until its first HEARTBEAT
    "heartbeatAt": "2026-09-27T21:59:58.000Z"
  }],
  "signalling": {                                     // null: telephony-config unreachable
    "status": "up", "uptimeSeconds": 8300,
    "registrations": 42, "activeDialogs": 5, "earlyDialogs": 1,
    "transactions": 7, "shmUsedBytes": 12000000, "shmTotalBytes": 268435456
  },
  "events": {                                         // null: NATS unreachable
    "streams": [{ "name": "CALL", "messages": 1200, "bytes": 800000, "consumers": 1 }],
    "consumers": [{ "stream": "CALL", "name": "telephony-config-nodes",
                    "pending": 0, "ackPending": 0, "redelivered": 0 }]
  },
  "dataStores": [{
    "name": "redis", "status": "up", "version": "7.4.1", "uptimeSeconds": 9000,
    "facts": [{ "label": "Memory used", "value": 2500000, "unit": "bytes" },
              { "label": "Clients", "value": 18, "unit": "count" },
              { "label": "Operations per second", "value": 35, "unit": "perSecond" }]
  }]
}
```

`dataStores[].facts` is a list so each store says what matters for it without the console knowing every store's vocabulary (`unit`: `bytes`, `count`, `perSecond`, `seconds`, `percent`).

Node actions, proxied to call-control (`/v1/platform/nodes=call`), each answering the node as in `nodes[]` above (without the dispatcher fields, which telephony-config fills in a moment later):

| Route | Permission | Effect |
|---|---|---|
| `POST /v1/platform/nodes/{id}/drain` | `platform.operate` | as S4-02's internal route, plus the audit event |
| `POST /v1/platform/nodes/{id}/undrain` | `platform.operate` | likewise |
| `PUT /v1/platform/nodes/{id}/weight` `{weight: 1..999}` | `platform.operate` | commits `call.node.weight_changed`; telephony-config writes the dispatcher row's weight and reloads the dispatcher (`ds_reload`) |

**The console's weight wins** (G-124): `seed-dispatcher.py` sets a weight only for a destination it adds. `OPENSIPS_FS_DESTINATION`'s `;weight=N` is the starting value for a new node, and a weight set in the console survives OpenSIPs restarts, as drain state already does.

### 2.3 Screen

One **Operations** section for the master (replacing Platform health), polling the overview every 5 s while it is open:

- **Overview:** tiles (services ready, media nodes in service, live calls, registrations, event backlog) and charts: calls per node (bars), node CPU (gauges), service response times (bars), consumer backlog (bars), and a rolling line of calls and backlog over the last minutes the page has been open (from its own polls, until S4-13's history).
- **Services:** every service with its status, response time, version, uptime, memory, outbox, and failing checks.
- **Media nodes:** one card per node: status and dispatcher state, calls, sessions against its maximum, CPU, leases, weight; **Drain**, **Return to service** and **Set weight**, each confirmed, for holders of `platform.operate`.
- **Signalling, Events, Data stores:** the corresponding sections as tables and charts.

Charts use `fl_chart` (MIT).

## 3. History (S4-13)

Services export metrics in Prometheus format through OpenTelemetry (09 §4) on `/metrics`: HTTP RED, outbox and consumer lag, and in call-control the media nodes' calls, sessions and CPU. OpenSIPs exports its statistics with its own `prometheus` module. A Prometheus server in the deployment scrapes them (15 days by default). The gateway answers `GET /v1/platform/metrics/{chart}?range=1h|6h|24h|7d` from a **fixed catalog** of charts (never a query from the browser), and the console's Overview shows those lines in place of its own rolling ones.
