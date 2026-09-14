# @cuc/storage

Wraps the S3 client (05 §4): bucket-per-tenant and prefix-per-tenant modes, presigned
GET/PUT with a maximum TTL, bucket provisioning (encryption + a public-access block),
and lifecycle rule helpers. No database, no HTTP — a service builds an
`ObjectLocation`'s bucket and key from a tenant id and a key it chooses, and gets a
presigned URL back.

```ts
import { createStorage } from '@cuc/storage';

const storage = createStorage({
  mode: config.STORAGE_MODE,
  bucketPrefix: config.STORAGE_BUCKET_PREFIX,
  endpoint: config.STORAGE_ENDPOINT,
  region: config.STORAGE_REGION,
  accessKeyId: config.STORAGE_ACCESS_KEY_ID,
  secretAccessKey: config.STORAGE_SECRET_ACCESS_KEY,
  forcePathStyle: config.STORAGE_FORCE_PATH_STYLE,
  logger,
});

const tenant = storage.forTenant(tenantId);
await tenant.provisionBucket(); // idempotent; call once, e.g. on tenant creation
const uploadUrl = await tenant.presignPut(`recordings/${callUuid}.wav`, {
  contentType: 'audio/wav',
});
```

`storageFromConfig(config, logger)` is the same thing built straight from
`storageEnvSchema`'s validated shape, matching `@cuc/crypto`'s `fileKekFromConfig`.

## Modes (O-9)

- **`bucket-per-tenant`** (the SAD default): each tenant gets its own bucket,
  `{STORAGE_BUCKET_PREFIX}-t-{tenantShortId}`.
- **`prefix-per-tenant`**: every tenant shares one bucket,
  `{STORAGE_BUCKET_PREFIX}-shared`, with keys prefixed `t-{tenantShortId}/`. Exists
  because some S3-compatible providers cap the number of buckets per account.

`tenantShortId` is the tenant's UUID with the hyphens stripped — the same id, just
bucket-name-safe, not a separate identifier a caller has to look up.

A third, fixed bucket, `{STORAGE_BUCKET_PREFIX}-platform`, holds reseller-scoped
objects (brand assets) — `forPlatform()` — regardless of `STORAGE_MODE`, since those
aren't tenant data at all.

`STORAGE_BUCKET_PREFIX` is capped at 28 characters: the longest name this produces is
`{prefix}-t-{32-hex-char tenant id}`, and S3 bucket names cap at 63.

## Presigned URLs

`presignGet`/`presignPut` clamp `ttlSeconds` to `MAX_GET_TTL_SECONDS` (5 min) /
`MAX_PUT_TTL_SECONDS` (15 min) — 05 §4's stated maximums — rather than reject an
excessive request; a caller asking for longer just gets the max instead of an error.
Omitting `ttlSeconds` uses the max.

## Provisioning: what's guaranteed and what's best-effort

`provisionBucket()` creates the bucket if it doesn't exist (idempotent — a second call
against the same bucket is a no-op) and then attempts to enable default encryption and
set a public-access block. Those two are **attempted, not required**: verified against
a real MinIO server, MinIO does not implement `PutPublicAccessBlock` at all (the
request lands on the wrong internal handler — confirmed from the server's own error
log) and rejects `PutBucketEncryption` with `AES256` unless a KMS backend is
configured, which a bare dev MinIO instance doesn't have. A provider that can't honor
one logs a warning through the `logger` passed to `createStorage` and the bucket still
gets created; real AWS S3 honors both. This is why "integration tests pass against
MinIO" (this task's acceptance line) doesn't mean MinIO enforces encryption or public
blocking in dev — it means the bucket, presigned URLs, and lifecycle rules all work
against it, which is what a service actually depends on.

## Lifecycle rules

`setLifecycleRule({ id, prefix, expirationDays })` maps directly to an S3 lifecycle
rule scoped by key prefix — a tenant's retention policy (05 §4) becomes one rule per
data category (`recordings/`, `voicemail/`, …). In prefix-per-tenant mode, a rule's
`prefix` should include the tenant's own `t-{tenantShortId}/` segment, or it will apply
to every tenant sharing that bucket.

## Testing

`@cuc/testing` gains `startTestS3()` / `s3OrSkipReason()`, matching the MariaDB/NATS
helpers exactly: `TEST_S3_URL` (`http://accessKey:secretKey@host:port`) points at an
already-running server — the compose stack's MinIO from S0-05 — or a Testcontainers
MinIO starts automatically. `test/storage.test.ts` runs every integration test against
both modes on the same server, including a real upload through a presigned PUT URL
followed by a real download through a presigned GET URL — not mocked S3 calls.
