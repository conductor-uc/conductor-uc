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

As built (backend). Every service serves `GET /metrics` in Prometheus' text format, from an OpenTelemetry meter (`@cuc/http`, 09 §4). Like `/readyz` it is on the internal network only, and it carries counts and timings, never tenant data: a label is a route pattern, a node id, a stream or a consumer.

| Metric | From | Labels |
|---|---|---|
| `http_server_request_duration_seconds` (histogram) | every service | `http_request_method`, `http_route` (the pattern, never the path), `http_response_status_code` |
| `outbox_pending`, `outbox_oldest_pending_seconds`, `outbox_failed` | every relaying service (`observeOutbox`) | |
| `fs_node_up`, `fs_node_draining`, `fs_node_calls`, `fs_node_sessions`, `fs_node_max_sessions`, `fs_node_cpu_idle_percent` | call-control (the registry and each HEARTBEAT) | `node` |
| `opensips_up`, `opensips_registrations`, `opensips_active_dialogs`, `opensips_early_dialogs`, `opensips_transactions`, `opensips_shm_used_bytes`; `fs_dispatcher_weight`, `fs_dispatcher_active`; `mariadb_up`, `mariadb_connections` | telephony-config (MI and MariaDB) | `node` for the dispatcher |
| `nats_consumer_pending`, `nats_consumer_ack_pending`, `nats_consumer_redelivered`, `nats_stream_messages`; `redis_used_memory_bytes`, `redis_connected_clients`, `redis_ops_per_second` | api-gateway (its NATS and Redis connections) | `stream`, `consumer` |
| the uploader's spool metrics | each recording uploader (`METRICS_PORT`) | |

OpenSIPs' own `prometheus` module is not in its image; telephony-config already reads the same statistics over MI and alone talks to OpenSIPs, so it exports them.

A Prometheus server (`prom/prometheus`, Apache-2.0) scrapes every service every 15 s and keeps 15 days (`PROMETHEUS_RETENTION`). Each target carries a `service` label, which the charts group by. In compose it is `infra/compose/prometheus/prometheus.yml`.

`GET /v1/platform/metrics/{chart}?range=1h|6h|24h|7d` (`platform.observe`, master only) answers one chart from a **fixed catalog** in the gateway (`platform-history.ts`); a browser names a chart and a range and never sends a query. About 120 points per range (a 30 s step over an hour, 84 minutes over a week).

| Chart | What | Lines |
|---|---|---|
| `calls-by-node`, `sessions-by-node` | calls and sessions on each media node | node |
| `node-cpu` | each node's busy CPU (100 − idle) | node |
| `registrations`, `dialogs` | registered phones, calls at the edge | one |
| `request-rate`, `error-rate` | requests and 5xx answers per second (5-minute rate) | service |
| `latency-p95` | 95th percentile response time | service |
| `outbox-pending`, `consumer-backlog` | events waiting to be published, and to be consumed | service, consumer |

Answers `{chart, unit, range, stepSeconds, series: [{label, points: [[unixSeconds, value], ...]}]}`; 404 `unknown_chart`; 503 `history_unavailable` when the gateway has no `PROMETHEUS_URL` or Prometheus does not answer, and the console keeps drawing only what it has seen since it opened. The console's History tab is the next step.
