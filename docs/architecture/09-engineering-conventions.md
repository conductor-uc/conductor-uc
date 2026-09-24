# 09 — Engineering conventions

## 1. TypeScript services

- Node.js 22 LTS, TypeScript `strict`, ESM.
- Fastify for HTTP, with `@fastify/type-provider-typebox` so one TypeBox schema drives both validation and OpenAPI.
- Kysely for DB access and migrations (type-safe SQL, no ORM magic, MariaDB dialect via `mysql2`).
- pino for logging (JSON), and OpenTelemetry for traces and metrics (OTLP exporter).
- Vitest for tests. Testcontainers for MariaDB, Redis, NATS, and MinIO in integration tests.
- Configuration comes only from environment variables, validated at startup by `@cuc/config` (TypeBox or zod schema). The service refuses to start on invalid config.

Service layout:

```
services/<name>/
  src/
    main.ts              bootstrap (config, logger, db, bus, http)
    routes/              HTTP route modules (schema + handler)
    domain/              business logic, pure where possible
    repo/                data access (uses scoped(ctx))
    events/              publishers (outbox) and consumers
  migrations/
  test/
  Dockerfile
  package.json
```

## 2. API style

- REST + JSON, versioned by path (`/v1`). Resource IDs are UUIDs.
- Tenant resources nest under `/v1/tenants/{tenantId}/…`. Reseller resources nest under `/v1/resellers/{resellerId}/…`.
- Custom actions use the `:verb` suffix (`POST /v1/tenants/{t}:suspend`).
- Errors use RFC 9457 `application/problem+json` with a stable `type` URI path (not a product domain: `/problems/validation`), a `code`, and field `errors[]`.
- Pagination is cursor-based: `?limit=&cursor=`, and the response carries `nextCursor`.
- Optimistic concurrency: `ETag` holds the row version, and `If-Match` is required on `PATCH`/`PUT`.
- `Idempotency-Key` is supported on all `POST` creates (stored for 24 h in Redis).
- Each route schema declares `dataClass` and `permission`, and `@cuc/http` enforces both (see [07](07-security-and-permissions.md)).

## 3. Testing strategy

| Level | Scope | Tooling | Runs |
|---|---|---|---|
| Unit | Pure domain logic, IR compiler, authz rules | Vitest | Every PR |
| Integration | One service + real MariaDB, Redis, and NATS | Vitest + Testcontainers | Every PR |
| Contract | OpenAPI and event schemas vs. consumers | Schema diff + generated client compile | Every PR |
| Tenancy | Cross-tenant probes, H1 matrix (reseller × private routes) | Vitest suite in `packages/testing` | Every PR |
| SIP functional | Registration, calls, features against the compose stack | SIPp scenarios in `tests/sip`, orchestrated by a Vitest runner | Every PR (smoke), nightly (full) |
| HA / chaos | Kill nodes under SIPp load | `tests/sip/chaos` | Nightly from S4 |
| Console | Widget tests; integration tests on the web build | `flutter test`, `flutter drive` / Playwright against `build/web` | Every PR |
| Brand leak | Deny-list scan of built artifacts | `tools/brand-leak` | Every PR |

## 4. Observability

- Logs: JSON with `requestId`, `traceId`, `tenantId`, `resellerId`, `actorId`, and `callUuid` where relevant. Never log secrets, SIP passwords, or media URLs with signatures.
- Metrics (Prometheus via OTel):
  - HTTP RED metrics
  - xml_curl latency per binding
  - Outbox lag
  - Consumer lag
  - Active calls per node and per tenant
  - Registrations
  - Dispatcher state
  - Upload spool size
- Traces: HTTP → service → DB and NATS. Call setup is traced by correlating the `callUuid` attribute across xml_curl requests.
- SIP capture: OpenSIPs and FS export HEP to Homer (dev and staging always; production optional).

## 5. CI (GitHub Actions)

The `ci.yml` workflow (triggers: push to `main`, pull requests, and a nightly schedule) has three jobs, all on **self-hosted runners** (long-lived hosts, not fresh VMs, so steps that start something by hand must remove it):

| Job | What it does |
|---|---|
| `check` | Formatting, then `turbo run lint typecheck test build` with `--affected` on pull requests and over everything on `main`; console OpenAPI and call-flow IR snapshot checks; brand-leak scan. Runs against MariaDB, Redis, Mailpit, a NATS binary and a hand-started MinIO. |
| `sip-smoke` | Builds and starts the compose stack and runs the S1-14 SIP smoke scenarios on push and pull request; the full `tests/sip` suite runs nightly (S2-20). |
| `console` | Flutter analyze, tests, web build, regenerated API client check, brand-leak scan including `build/web`. |

Container images are not built or pushed by this workflow yet (the compose stack builds them locally).

## 6. Rules for implementers (also summarized in the repository `CLAUDE.md`)

1. Never query a tenant-owned table without `scoped(ctx)`.
2. Never add a user-facing string, asset, header, or default containing the codebase name or an operator name.
3. Every route declares `permission` and `dataClass`.
4. Domain services never write FreeSWITCH XML or OpenSIPs tables. Publish an event; telephony-config projects it.
5. FreeSWITCH nodes must stay stateless: no durable writes on the node.
6. Every state change that other services care about goes through the outbox.
7. Every migration is backward compatible with the previous service version (expand, then contract).
