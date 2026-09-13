# @cuc/api-contracts

Versioned event contracts and the envelope shape (05 §5). No runtime dependencies beyond TypeBox,
so anything can import it — publishers, consumers, and the console's generated client.

```ts
import { Type, defineEvents } from '@cuc/api-contracts';

export const pbxEvents = defineEvents({
  'pbx.extension.created': {
    schemaVersion: 1,
    description: 'An extension was created.',
    data: Type.Object({ extensionId: Type.String(), number: Type.String() }),
  },
});
```

`defineEvents` validates every subject **at registration**, so `pbx.Extension.create` or a subject
in an unknown domain fails at module load rather than the first time something publishes it. Use
`mergeEvents` to keep one file per domain; registering a type twice is an error.

## Subjects and streams

Subjects are `{domain}.{entity}.{verb}`, one JetStream stream per domain (`pbx.>` → `PBX`).

Two segments after the domain is the canonical shape, but 05 §5's own examples include `call.lost`,
which has one — so both are accepted rather than pretending the convention is uniform. Four or more
is rejected, because a deeper subject is nearly always a filter pattern that leaked into an event
type.

## Validation

| Call | Checks |
|---|---|
| `assertPayload(type, data)` | `data` against the registered contract |
| `assertEnvelope(envelope)` | the envelope shape, that the type is registered, that `schemaVersion` matches the contract, **and** the payload |

The envelope rejects unknown properties, so a `tenantId` written at the top level instead of inside
`orgContext` is an error rather than a field silently carried and ignored.

## Versioning

`schemaVersion` is bumped only for a breaking change to `data`, and a breaking change also needs a
dual-publish period (05 §5). `assertEnvelope` rejects a version that disagrees with the registered
contract, which is what makes the dual-publish window visible instead of silent.
