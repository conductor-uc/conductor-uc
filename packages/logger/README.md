# @cuc/logger

pino, configured for the platform: JSON on stdout, ISO timestamps, level labels, and
redaction of secret paths (09 §4).

```ts
import { createLogger, withContext } from '@cuc/logger';

const logger = createLogger({ name: config.SERVICE_NAME, level: config.LOG_LEVEL });

withContext(logger, { requestId, tenantId }).info({ extensionId }, 'extension updated');
```

## Redaction

Redaction is not optional. `createLogger({ redact })` **adds** paths; it cannot remove the
defaults. A service that needs to read a secret out of a log has a bug, not a logging problem.

- Secret leaf keys (`password`, `token`, `apiKey`, `sipPassword`, `ha1`, `mfaSecret`, …, in both camelCase and snake_case) are replaced with `[redacted]`, at the top level and up to two levels deep.
- `authorization`, `cookie`, `set-cookie`, and `x-api-key` are stripped from `req.headers` and `res.headers`.
- Signed media URLs (`recordingUrl`, `voicemailUrl`, `downloadUrl`, …) keep their origin and path but lose the query, so a log line still identifies the object without carrying a working download link. A `*Url` value that is not a URL is masked outright.

`withContext` attaches the correlation fields from 09 §4 — `requestId`, `traceId`, `tenantId`,
`resellerId`, `actorId`, `callUuid` — and drops the ones that are not known yet.
