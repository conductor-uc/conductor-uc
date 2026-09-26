import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server } from '@cuc/http';

import type { AffinityManager } from '../affinity/manager.js';
import type { CallRegistry } from '../redis/registry.js';

const KindSchema = Type.Union([Type.Literal('queue'), Type.Literal('park'), Type.Literal('conf')]);

const ParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  kind: KindSchema,
  resourceId: Type.String({ minLength: 1 }),
});

const AcquireBodySchema = Type.Object({
  reloadCommands: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  /** S2-13: `AffinityManager.acquire`'s own `preferredNodeId` — see its doc comment for when a caller should set this. */
  preferredNodeId: Type.Optional(Type.String({ minLength: 1 })),
});

const OwnerResponseSchema = Type.Object({
  nodeId: Type.Union([Type.String(), Type.Null()]),
});

const AcquireResponseSchema = Type.Object({
  nodeId: Type.String(),
  acquired: Type.Boolean(),
});

const TenantParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1, maxLength: 64 }),
});

const LiveCallSchema = Type.Object({
  callUuid: Type.String(),
  nodeId: Type.String(),
  tenantId: Type.String(),
  direction: Type.Union([Type.Literal('inbound'), Type.Literal('outbound')]),
  state: Type.Union([Type.Literal('ringing'), Type.Literal('answered'), Type.Literal('held')]),
  /** Unix milliseconds. */
  startedAt: Type.Number(),
  answeredAt: Type.Union([Type.Number(), Type.Null()]),
  from: Type.String(),
  to: Type.String(),
  bridgedTo: Type.Union([Type.String(), Type.Null()]),
  /** `paused` since S5-15. */
  recording: Type.Union([Type.Literal('on'), Type.Literal('off'), Type.Literal('paused')]),
  /** S5-15: the extension the leg belongs to, when the node vouches for it (`normalize.ts`). */
  extension: Type.Union([Type.String(), Type.Null()]),
  /** S5-15: what the recording buttons may do on the call. */
  controls: Type.Union([Type.Literal('none'), Type.Literal('on_demand'), Type.Literal('pause')]),
});

const LiveCallsResponseSchema = Type.Object({ calls: Type.Array(LiveCallSchema) });

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token !== undefined && token !== '' ? token : undefined;
}

/**
 * `/internal/v1/affinity/...` (S2-12; 04 §3.3) — the resource affinity lease
 * abstraction: acquire (choosing the least-loaded live node and triggering
 * its FS reload), release, and a read-only lookup. Callers are the future
 * owners of a pinned resource kind (S2-13 queues, S2-14 parking, S2-15
 * conferences) plus telephony-config's own direct-Redis read for its
 * `configuration` xml_curl binding (`packages/affinity`'s `getOwner` used
 * directly there, the same "read the shared Redis state directly" pattern
 * `ring-group-counter.ts` already established, rather than a second HTTP
 * hop through here for a plain lookup) — but the *write* path (acquire/
 * release) only exists here, since only this service holds the ESL
 * connections a fresh acquire needs (07 §1's "only call-control talks ESL"
 * symmetry).
 *
 * Same gating as every other `/internal/v1` route in this codebase (07 §1's
 * precedent): a shared `INTERNAL_SERVICE_TOKEN` bearer check inside the
 * handler.
 */
export function registerInternalRoutes(
  app: Server,
  affinity: AffinityManager,
  internalServiceToken: string,
  registry: CallRegistry,
): void {
  function authorized(header: string | undefined): boolean {
    const presented = bearerToken(header);
    return presented !== undefined && secretEquals(internalServiceToken, presented);
  }

  app.post(
    '/internal/v1/affinity/:tenantId/:kind/:resourceId/acquire',
    {
      config: { public: true },
      schema: {
        params: ParamsSchema,
        body: AcquireBodySchema,
        response: { 200: AcquireResponseSchema },
      },
    },
    async (request) => {
      if (!authorized(request.headers.authorization)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }
      const { tenantId, kind, resourceId } = request.params;
      const result = await affinity.acquire(tenantId, kind, resourceId, {
        reloadCommands: request.body.reloadCommands ?? [],
        ...(request.body.preferredNodeId === undefined
          ? {}
          : { preferredNodeId: request.body.preferredNodeId }),
      });
      return result;
    },
  );

  app.post(
    '/internal/v1/affinity/:tenantId/:kind/:resourceId/release',
    { config: { public: true }, schema: { params: ParamsSchema } },
    async (request, reply) => {
      if (!authorized(request.headers.authorization)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }
      const { tenantId, kind, resourceId } = request.params;
      await affinity.release(tenantId, kind, resourceId);
      return reply.status(204).send();
    },
  );

  app.get(
    '/internal/v1/affinity/:tenantId/:kind/:resourceId',
    {
      config: { public: true },
      schema: { params: ParamsSchema, response: { 200: OwnerResponseSchema } },
    },
    async (request) => {
      if (!authorized(request.headers.authorization)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }
      const { tenantId, kind, resourceId } = request.params;
      const nodeId = await affinity.getOwner(tenantId, kind, resourceId);
      return { nodeId: nodeId ?? null };
    },
  );

  /**
   * `GET /internal/v1/tenants/:tenantId/calls` (06, S5-08): the tenant's live
   * calls, straight from the Redis registry (04 §3.2). api-gateway's realtime
   * hub asks for it when someone subscribes to `tenant:{t}:calls` (and to build
   * presence), then applies `call.channel.*` events on top. Each entry is one
   * channel; the two legs of a bridged call point at each other by `bridgedTo`.
   * The parties' numbers are private-class data (07 §3.2): the gateway decides
   * who may see them, this route only answers the shared service token.
   */
  app.get(
    '/internal/v1/tenants/:tenantId/calls',
    {
      config: { public: true },
      schema: { params: TenantParamsSchema, response: { 200: LiveCallsResponseSchema } },
    },
    async (request) => {
      if (!authorized(request.headers.authorization)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }
      return { calls: await registry.callsForTenant(request.params.tenantId) };
    },
  );
}
