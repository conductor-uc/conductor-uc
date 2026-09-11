# CLAUDE.md

Multi-tenant UC/PBX platform: OpenSIPs edge, FreeSWITCH media nodes, Node.js/TypeScript microservices, and a Flutter web console.

- Architecture baseline: `docs/sad.md`
- Technical design: `docs/architecture/`
- Work is organized by task ID in `docs/plan/implementation-plan.md`. When picking up a task, read its row, its dependencies, and its "Done when" criteria first.
- Decisions and open questions: `docs/decisions.md`. Don't implement against a *Proposed* or *Open* decision without flagging it.

## Non-negotiable rules

1. **No branding on user-facing surfaces.** The Master tier is completely unbranded. "ConductorUC" is a codebase name only. Never put it, or any operator or company name, into UI strings, `apps/console/web/*`, email templates, SIP headers, SDP, prompts, HTTP headers, or API error text. Only reseller brands (or the neutral theme) are rendered. `tools/brand-leak` enforces this.
2. **Tenant scoping.** Tenant-owned data is accessed only through `scoped(ctx)` from `@cuc/db`.
3. **Every route declares `permission` and `dataClass`.** Resellers can never read `private` data (rule H1).
4. **Domain services never write FreeSWITCH XML or OpenSIPs tables.** Emit an event, and `telephony-config` projects it.
5. **FreeSWITCH nodes stay stateless.** No durable writes on nodes; media goes to S3.
6. **Cross-service state changes go through the transactional outbox** (`@cuc/events`).
