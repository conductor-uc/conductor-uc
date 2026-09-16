import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server, type Static } from '@cuc/http';

import type { OutboundRouteRepo } from '../repo/outbound-route.repo.js';
import type { TrunkRepo } from '../repo/trunk.repo.js';

const TenantTrunkParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});

const OutboundRouteViewSchema = Type.Object({
  id: Type.String(),
  tenantId: Type.String(),
  priority: Type.Integer(),
  pattern: Type.String(),
  trunkIds: Type.Array(Type.String()),
  strip: Type.Integer(),
  prepend: Type.Union([Type.String(), Type.Null()]),
});

const CallerIdPolicySchema = Type.Object({
  name: Type.Union([Type.String(), Type.Null()]),
  number: Type.Union([Type.String(), Type.Null()]),
});

const ProjectionViewSchema = Type.Object({
  id: Type.String(),
  tenantId: Type.String(),
  resellerId: Type.String(),
  name: Type.String(),
  authMode: Type.String(),
  host: Type.String(),
  port: Type.Integer(),
  transport: Type.String(),
  username: Type.Union([Type.String(), Type.Null()]),
  secret: Type.Union([Type.String(), Type.Null()]),
  fromDomain: Type.Union([Type.String(), Type.Null()]),
  codecs: Type.Array(Type.String()),
  maxChannels: Type.Union([Type.Integer(), Type.Null()]),
  /** S2-04's caller-ID precedence, third tier (G-22). */
  callerIdPolicy: Type.Union([CallerIdPolicySchema, Type.Null()]),
  status: Type.String(),
  ips: Type.Array(Type.String()),
});

/**
 * `GET /internal/v1/tenants/:tenantId/trunks/:id` and
 * `GET /internal/v1/trunks` (S2-02). What telephony-config calls to project
 * a trunk into OpenSIPs' `registrant`/`address`/`dr_gateways`/`dr_groups`
 * (03 §1) — the `trunk.trunk.*` events carry only `{trunkId, name,
 * authMode}` (06: events stay thin), and the reconciliation pass needs every
 * trunk at once, which no public route offers.
 *
 * Same gating as every other service's `/internal/v1` routes (07 §1's
 * precedent): a shared `INTERNAL_SERVICE_TOKEN` bearer check inside the
 * handler, not the `permission`/`dataClass` contract, since there is no real
 * service-to-service auth yet. This is also, functionally, a second
 * `:reveal` path — it returns the plaintext register secret — gated by that
 * token instead of the `secret.reveal` permission because the caller is
 * telephony-config itself, not an identified human actor.
 */
export function registerInternalRoutes(
  app: Server,
  trunks: TrunkRepo,
  outboundRoutes: OutboundRouteRepo,
  internalServiceToken: string,
): void {
  app.get(
    '/internal/v1/tenants/:tenantId/trunks/:id',
    {
      config: { public: true },
      schema: { params: TenantTrunkParamsSchema, response: { 200: ProjectionViewSchema } },
    },
    async (request) => {
      requireInternalToken(request.headers.authorization, internalServiceToken);

      const { tenantId, id } = request.params;
      const trunk = await trunks.findForProjection(tenantId, id);
      if (trunk === undefined) throw ProblemError.notFound('No trunk with that id in that tenant.');
      return { ...trunk, codecs: [...trunk.codecs], ips: [...trunk.ips] } satisfies Static<
        typeof ProjectionViewSchema
      >;
    },
  );

  app.get(
    '/internal/v1/trunks',
    {
      config: { public: true },
      schema: { response: { 200: Type.Object({ rows: Type.Array(ProjectionViewSchema) }) } },
    },
    async (request) => {
      requireInternalToken(request.headers.authorization, internalServiceToken);
      const views = await trunks.listAllForProjection();
      return {
        rows: views.map((trunk) => ({ ...trunk, codecs: [...trunk.codecs], ips: [...trunk.ips] })),
      };
    },
  );

  /**
   * `GET /internal/v1/tenants/:tenantId/outbound-routes/:id` and
   * `GET /internal/v1/outbound-routes` (S2-04) — the same shape as the
   * trunk routes above: `trunk.outboundRoute.*` events carry only an id
   * (06: events stay thin), and reconciliation needs every route at once.
   */
  app.get(
    '/internal/v1/tenants/:tenantId/outbound-routes/:id',
    {
      config: { public: true },
      schema: { params: TenantTrunkParamsSchema, response: { 200: OutboundRouteViewSchema } },
    },
    async (request) => {
      requireInternalToken(request.headers.authorization, internalServiceToken);

      const { tenantId, id } = request.params;
      const route = await outboundRoutes.findById({ tenantId }, id);
      if (route === undefined) {
        throw ProblemError.notFound('No outbound route with that id in that tenant.');
      }
      return { ...route, trunkIds: [...route.trunkIds] } satisfies Static<
        typeof OutboundRouteViewSchema
      >;
    },
  );

  app.get(
    '/internal/v1/outbound-routes',
    {
      config: { public: true },
      schema: { response: { 200: Type.Object({ rows: Type.Array(OutboundRouteViewSchema) }) } },
    },
    async (request) => {
      requireInternalToken(request.headers.authorization, internalServiceToken);
      const routes = await outboundRoutes.listAll();
      return { rows: routes.map((route) => ({ ...route, trunkIds: [...route.trunkIds] })) };
    },
  );
}

function requireInternalToken(authorization: string | undefined, expected: string): void {
  const presented = bearerToken(authorization);
  if (presented === undefined || !secretEquals(expected, presented)) {
    throw ProblemError.unauthorized('A valid internal service token is required.');
  }
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token !== undefined && token !== '' ? token : undefined;
}
