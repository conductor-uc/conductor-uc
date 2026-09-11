# ConductorUC technical documentation

These docs turn the [Software Architecture Document](sad.md) into implementation-level design and a staged plan that can be split into individual pull requests.

## Reading order

| # | Document | What it covers |
|---|---|---|
| — | [sad.md](sad.md) | Source architecture (v1.1). The requirements baseline. |
| 01 | [System overview](architecture/01-system-overview.md) | Components, deployment view, monorepo layout, main request flows |
| 02 | [Tenancy & branding](architecture/02-tenancy-and-branding.md) | Org hierarchy, provisioning, domains, white-label, **unbranded Master**, brand-leak rules |
| 03 | [Signaling & media](architecture/03-signaling-and-media.md) | OpenSIPs and FreeSWITCH roles, config delivery, trunks, call flows, stateless nodes |
| 04 | [High availability](architecture/04-high-availability.md) | Redis call-ownership registry, resource affinity, failover sequences |
| 05 | [Data architecture](architecture/05-data-architecture.md) | Database-per-service, core schemas, tenant scoping, object storage, events |
| 06 | [Service catalog](architecture/06-services.md) | Every service: responsibilities, owned data, APIs, events, dependencies |
| 07 | [Security & permissions](architecture/07-security-and-permissions.md) | AuthN, the grant-based AuthZ model, data classes, audit, secrets |
| 08 | [Console](architecture/08-console.md) | Flutter web app structure, theming, call-flow builder, live monitoring |
| 09 | [Engineering conventions](architecture/09-engineering-conventions.md) | API style, testing strategy, observability, CI, coding rules |
| — | [Implementation plan](plan/implementation-plan.md) | Stages 0–8 with task IDs, dependencies, and acceptance criteria |
| — | [Decisions & open questions](decisions.md) | Decision register, open questions, and gaps/conflicts found in the SAD |

## Conventions used in these docs

- **MUST / SHOULD / MAY** carry their RFC 2119 meanings.
- Items marked **(Proposed)** are recommendations made while writing these docs. Each one maps to an entry in [decisions.md](decisions.md) that needs sign-off before the stage that depends on it.
- Task IDs such as `S2-07` refer to the [implementation plan](plan/implementation-plan.md).
- "ConductorUC" is the **codebase name only**. User-facing surfaces never show it (see [02 §5](architecture/02-tenancy-and-branding.md#5-branding)).
