# @cuc/audit

The `AUDIT` stream publisher (07 §4): what a write, a private/secret read, an authentication
event, or a monitoring action look like as one `audit.event.recorded` envelope, and the two
ways a service actually sends one. No database of its own — `audit_events` (05 §3.2) lives
in identity-service, which consumes this stream (06's "identity-service owns … the audit
store").

```ts
import { recordAuditEvent, publishAuditEvent } from '@cuc/audit';

// A write: inside the same transaction as the business row (CLAUDE.md rule 6).
await db.kysely.transaction().execute(async (trx) => {
  await trx.updateTable('extensions').set({ ... }).where('id', '=', id).execute();
  await recordAuditEvent(trx, {
    actorType: 'user', actorId: actor.id, actorOrgId: actor.orgId,
    targetOrgId: tenantId, action: 'extension.updated', resource: `extension:${id}`,
    dataClass: 'config',
  });
});

// A read: no business write to be atomic with, so this publishes directly.
await publishAuditEvent(bus, {
  actorType: 'user', actorId: actor.id, actorOrgId: actor.orgId,
  targetOrgId: tenantId, action: 'cdr.read', resource: `cdr:${cdrId}`,
  dataClass: 'private',
});
```

## Two publish paths, because 07 §4 has two kinds of thing to audit

- **`recordAuditEvent(db, input)`** — the standard outbox path (`enqueueEvent` under the
  hood), for **writes**. Call it inside the same transaction as the row it describes, so the
  audit trail and the change it documents commit or roll back together. This is "all writes"
  from 07 §4's list.
- **`publishAuditEvent(bus, input)`** — publishes straight to NATS, no outbox row. A **read**
  commits nothing, so there is no business write to be atomic with in the first place — this
  is "all private/secret reads" and "all authentication events." Best-effort: a publish
  failure is the caller's to handle, not a reason to fail the read that triggered it.

Both produce the same `audit.event.recorded` envelope and the same `AuditEventInput` shape —
picking the right one is about *when in the request* you have something to be atomic with,
not about the data.

## `toUnscopedAccessSink`

`@cuc/db`'s `unscoped(ctx, reason)` takes an `onUnscopedAccess` sink and defaults to a
`warn`-log line until something better is wired in — this is that something:

```ts
import { toUnscopedAccessSink } from '@cuc/audit';

const db = createDatabase({ ..., onUnscopedAccess: toUnscopedAccessSink(bus, logger) });
```

`UnscopedAccess` carries no target org or resource — a cross-tenant query is about many orgs
at once, not one — so this records it as a `private`-class `unscoped_query` action with the
reason as its resource, rather than inventing a target that doesn't exist.

## Visibility

Recording is this package's job; *who gets to read a recorded event back* is
identity-service's `GET /v1/orgs/:orgId/audit-events` — see its README for the visibility
rule (07 §4: "tenants can read their own audit trail… but not master-internal details").
