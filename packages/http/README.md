# @cuc/http

The Fastify factory every service bootstraps from (09 §1). One call wires in the platform's
HTTP conventions, so a service does not re-derive them.

```ts
import { Type, createServer } from '@cuc/http';

const app = await createServer({
  serviceName: config.SERVICE_NAME,
  serviceVersion: config.SERVICE_VERSION,
  logLevel: config.LOG_LEVEL,
  context: { trustInternalHeaders: true }, // only behind api-gateway
});

app.addReadinessCheck('db', async () => ({ status: (await db.ping()) ? 'pass' : 'fail' }));

app.get(
  '/v1/tenants/:tenantId/extensions',
  {
    config: { permission: 'extension.manage', dataClass: 'config' }, // required
    schema: { response: { 200: Type.Object({ rows: Type.Array(Extension) }) } },
  },
  async (request) => repo.list(request.context),
);

await app.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
```

`createServer` is async because `@fastify/swagger` collects routes through an `onRoute` hook and
has to be loaded before the first route is registered.

## Every route declares its contract

`config.permission` and `config.dataClass` are mandatory (CLAUDE.md rule 3). A route that omits
either throws `RouteContractError` — at the registration call for a route on the root instance,
or as a rejected `app.ready()` for one inside a plugin. It is a type error as well, because the
contract widens Fastify's `FastifyContextConfig`.

`config: { public: true }` is the only way past the guard, and it is reserved for the
infrastructure routes this factory registers itself. `app.registeredRoutes` exposes the whole
surface so CI can assert over it (07 §3.2).

## What you get

| Concern | Behaviour |
|---|---|
| Health | `GET /healthz` (liveness, touches no dependency) and `GET /readyz` (503 when any registered check fails) |
| OpenAPI | `GET /openapi.json`, OpenAPI 3.1, titled with the service name. Health and OpenAPI routes are hidden from it. |
| Errors | RFC 9457 `application/problem+json` with a path-only `type`, a stable `code`, `errors[]` for field failures, and the `requestId` |
| Correlation | `x-request-id` is reused if the caller sent one, `traceparent` is continued, and both land on every log line |
| Request context | `request.context` carries `requestId`, `traceId`, and — when trusted — `actorId`, `orgId`, `orgType`, `resellerId`, `tenantId` |
| Hard rules H1 & H3 | A reseller actor on a `private` route, or a non-master actor on a reseller-lifecycle route (`reseller.create`/`reseller.manage`), gets 403 before the handler runs — no grant can override either (07 §3.1) |

## Two things to get right

**`trustInternalHeaders` defaults to false.** The `x-internal-*` identity headers are only
trustworthy when the service is reachable solely through api-gateway, which authenticates the
caller and signs them. A directly reachable service that trusted them would let any client name
its own tenant. Signature verification arrives with identity-service in S1.

**5xx responses never carry the cause.** The error is logged at `error` with the request id; the
client gets `The request could not be completed.` Connection strings and stack traces stay out
of API responses.

## Headers

Neither `Server` nor `X-Powered-By` is emitted (02 §5.5). Fastify sends neither, and nothing here
adds them. The `onSend` strip is a backstop for the plugins this factory registers — Fastify runs
`onSend` hooks in registration order, so a hook a service adds later still runs after it. Keeping
these off the wire is enforced by review and the S0-07 brand-leak scan, not by this factory alone.
