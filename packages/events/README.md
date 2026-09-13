# @cuc/events

NATS JetStream with a transactional outbox. Every cross-service state change goes through here
(CLAUDE.md rule 6).

## Publishing

```ts
import { enqueueEvent } from '@cuc/events';

await db.kysely.transaction().execute(async (trx) => {
  await trx.insertInto('extensions').values(row).execute();

  await enqueueEvent(trx, pbxEvents, {
    type: 'pbx.extension.created',
    data: { extensionId: row.id, number: row.number },
    orgContext: { tenantId: ctx.tenantId },
    actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId },
    correlationId: ctx.requestId,
  });
});
```

**The outbox row must be written in the same transaction as the rows it describes.** That is the
whole point: they commit or roll back together, so an event can never describe a write that did not
happen, and a write can never go unannounced. The payload is validated here, not in the relay, so a
bad event fails in the request that caused it — where there is a stack trace and someone to see it.

`data` is type-checked against the registered contract for that `type`, so a wrong field is a
compile error as well as a runtime one.

## The relay

```ts
const relay = createRelay({ db: db.kysely, bus, logger });
void relay.run();          // until relay.stop()
await relay.lag();         // unpublished rows, for the outbox-lag metric (09 §4)
```

**Publish first, then mark sent.** The other order loses events: a crash between marking and
publishing means the event is never sent and nothing knows it is missing. In this order a crash
between the two means the row is published again on restart — at-least-once on the wire, which is
the contract consumers are written against.

- `FOR UPDATE SKIP LOCKED` lets several relay instances share one outbox without publishing a row
  twice and without blocking each other.
- A failed publish backs off exponentially and, after `maxAttempts`, is **parked, not dropped**: the
  row stays unpublished with the error recorded so an operator can requeue it, and it stops being
  claimed so it cannot block the rows behind it.

## Consuming

```ts
const consumer = createConsumer<ServiceDb>({
  db: db.kysely,
  bus,
  logger,
  registry: pbxEvents,
  durable: 'telephony-config',   // stable across restarts; JetStream keys delivery state on it
  subjects: ['pbx.extension.created', 'pbx.extension.updated'],
  handler: async (envelope, trx) => {
    await trx.insertInto('extension_read_model').values(project(envelope)).execute();
  },
});

await consumer.ensure();
void consumer.run();
```

Delivery is at-least-once. The handler runs **at most once per event**, because the event id is
inserted into `consumed_events` in the same transaction as the handler's work — a redelivery
collides on the primary key and is skipped. Do the work on the `trx` you are given and nothing else,
or you lose that guarantee.

Failure handling:

| Situation | What happens |
|---|---|
| Handler throws | Left un-acked and redelivered with exponential back-off. The transaction rolled back, so neither the work nor the dedupe record survived — the retry is a real second chance. |
| Handler keeps throwing | Termed after `maxDeliver`, so the consumer is not wedged behind one message. |
| Message is not JSON, or is off-contract | Termed immediately. Redelivery cannot help, and leaving it un-acked would stall everything behind it. |

`nak` is always given a delay. Without one the message is available again instantly and the consumer
burns every retry inside a single pass, hammering whatever is already failing.

## Why dedupe lives in the database

Two mechanisms, and only one of them is a guarantee:

- The envelope `id` goes out as `Nats-Msg-Id`, so the **server** collapses a republish inside the
  stream's `duplicate_window` (two minutes — comfortably longer than a relay restart).
- `consumed_events` is a table, so it outlives both that window and any restart.

Redis is not used for this: the SAD makes Redis ephemeral, and dedupe has to survive a flush.

## Migrations

```ts
import { createEventTables } from '@cuc/events';

export async function up(db: Kysely<unknown>): Promise<void> {
  await createEventTables(db);   // outbox + consumed_events
}
```

`outbox.tenant_id` is nullable, because a master-level event such as `org.reseller.created` belongs
to no tenant. The outbox is therefore **not** a tenant-scoped table and is never reached through
`scoped(ctx)`; the tenant context travels in the row's own columns.

`consumed_events` grows forever without a retention sweep — it is indexed on `consumed_at` for
exactly that. Deleting rows older than the longest plausible redelivery window is safe; deleting
more aggressively re-opens the duplicate-handler window.
