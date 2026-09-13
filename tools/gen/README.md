# @cuc/gen

Generates a new service from the layout in [09 §1](../../docs/architecture/09-engineering-conventions.md#1-typescript-services).

```sh
pnpm gen:service billing-service
pnpm gen:service billing-service --entity invoice-line --domain trunk
```

## What it produces

A complete, runnable service — not a skeleton that needs filling in before it does anything:

| Path | Contains |
|---|---|
| `src/main.ts` | Bootstrap: config, logger, DB, bus, HTTP server, health checks, graceful shutdown on SIGTERM |
| `src/config.ts` | The service's environment schema, validated at startup |
| `src/schema.ts` | Its Kysely `Db` interface |
| `src/events.ts` | Its own event contracts, registered with `@cuc/api-contracts` |
| `src/domain/` | Pure business logic for a sample entity |
| `src/repo/` | Data access through `scoped(ctx)`, writing its outbox row in the same transaction as the business row (rule 2, rule 6) |
| `src/routes/` | HTTP routes, each declaring `permission` and `dataClass` (rule 3) |
| `migrations/` | The outbox/consumed_events tables plus the sample entity's own table |
| `test/` | A repo test with a cross-tenant probe (05 §2.4), and a domain test |
| `Dockerfile` | Distroless, non-root, multi-stage |

The sample entity (`widget` by default) is a real, working vertical slice — create, list, get by id,
with its own event — so a developer sees the shape the conventions produce, not just a folder
structure. `--entity` and `--domain` name it something closer to the service's actual domain from
the start.

## Options

| Flag | Default | |
|---|---|---|
| `--entity <name>` | `widget` | kebab-case; also determines the table name via naive pluralization |
| `--domain <domain>` | `pbx` | Must be one of the event domains in 05 §5 |
| `--root <path>` | cwd | Repository root |
| `--force` | off | Overwrite an existing `services/<name>` |

## Two placeholders that look similar and are not

Templates carry `{{entity}}` (camelCase, for identifiers: `createWidgetRepo`) and `{{kebabEntity}}`
(for file and import paths: `widget.repo.ts`). They matter for anything past one word — an entity
named `invoice-line` produces `invoice-line.repo.ts` and `createInvoiceLineRepo`, not
`invoiceLine.repo.ts`. Getting this backwards was caught by `test/generate.test.ts`, which is why
that test exists rather than only checking the single-word default.

## Verified, not assumed

The acceptance criterion is that a generated service builds, runs, and passes its tests — so all
three were actually exercised, against real MariaDB and a real JetStream server: `pnpm build`,
`pnpm test` (9 tests including the cross-tenant probe), and the compiled process itself, started
with `node dist/src/main.js`, hit over HTTP (create, list, tenant isolation, 404, validation, the
outbox event actually reaching the stream), and stopped with `SIGTERM` — logging `shutting down` →
`outbox relay stopped` → `shutdown complete` and exiting 0.

**What is not yet verified: running inside `infra/compose`.** That stack does not exist yet (S0-05),
and this environment has no Docker daemon to check one against even if it did. The generated
`Dockerfile` is untested for the same reason. Whoever picks up S0-05 should add the generated
service to the compose stack and confirm the container builds and starts there too.
