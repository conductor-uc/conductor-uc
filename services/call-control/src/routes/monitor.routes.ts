import { clientIpOf, ProblemError, Type, type RequestContext, type Server } from '@cuc/http';

import type { MonitorController, MonitorMode } from '../monitor-control.js';

const ParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1, maxLength: 64 }),
  /** A channel uuid from the live calls feed (either leg of the call). */
  callUuid: Type.String({ minLength: 1, maxLength: 64, pattern: '^[0-9A-Za-z][0-9A-Za-z-]*$' }),
});

const ResultSchema = Type.Object({
  mode: Type.Union([Type.Literal('listen'), Type.Literal('whisper'), Type.Literal('barge')]),
  /** The leg the supervisor joined: the tenant's own party on the call, when it has one. */
  callUuid: Type.String(),
  /** The supervisor's own leg (the call to their phone), as the live calls feed shows it. */
  monitorCallUuid: Type.String(),
});

interface SignedRequest {
  readonly context: RequestContext;
}

/** The signed-in person. Only people monitor calls: never an API key or a service. */
function person(request: SignedRequest) {
  const { actorId, actorType, orgId, orgType } = request.context;
  if (actorId === undefined || orgId === undefined || orgType === undefined) {
    throw ProblemError.unauthorized('Sign in to continue.');
  }
  if (actorType !== 'user') {
    throw ProblemError.forbidden('Only a signed-in person can monitor a live call.', {
      code: 'people_only',
    });
  }
  return { id: actorId, orgId, orgType, resellerId: request.context.resellerId ?? null };
}

/**
 * One route per mode, each written out in full: api-gateway's route-table test finds every service
 * route by its path literal, so a path built at run time would escape it.
 */
const ROUTES: readonly {
  readonly mode: MonitorMode;
  readonly path: string;
  readonly permission: 'monitor.listen' | 'monitor.whisper' | 'monitor.barge';
}[] = [
  {
    mode: 'listen',
    path: '/v1/tenants/:tenantId/calls/:callUuid/listen',
    permission: 'monitor.listen',
  },
  {
    mode: 'whisper',
    path: '/v1/tenants/:tenantId/calls/:callUuid/whisper',
    permission: 'monitor.whisper',
  },
  {
    mode: 'barge',
    path: '/v1/tenants/:tenantId/calls/:callUuid/barge',
    permission: 'monitor.barge',
  },
];

/**
 * S5-09: listen to, whisper into and barge a live call, from the supervisor's own phone (O-14).
 *
 * `POST /v1/tenants/{tenantId}/calls/{callUuid}/listen|whisper|barge`, each gated by its own
 * permission (`monitor.listen`, `monitor.whisper`, `monitor.barge`; class `private`, so never a
 * reseller: H1). The permission is checked against the call itself (`scopedPermission`): held
 * across the tenant it covers every call, a grant on an extension or a queue covers only the calls
 * that touch it (G-121). No body. The request returns once the phone has answered and joined.
 *
 * Answers: 200 `{mode, callUuid, monitorCallUuid}`; 404 `call_not_found` (no such call in progress
 * in this tenant), `no_linked_extension` (no phone to ring); 403 `insufficient_permission` (not for
 * this call), `people_only`, and the guard's `tenant_boundary` and `reseller_private_data_denied`;
 * 409 `call_not_answered`, `own_call`, `phone_unreachable`, `phone_not_answered`; 503
 * `permissions_unavailable`, `monitor_unavailable`, `media_unavailable` (nothing was done) and
 * `media_node_failed`.
 */
export function registerMonitorRoutes(
  app: Server,
  deps: { readonly controller: MonitorController },
): void {
  for (const { mode, path, permission } of ROUTES) {
    app.post(
      path,
      {
        config: { permission, dataClass: 'private', scopedPermission: true },
        schema: { params: ParamsSchema, response: { 200: ResultSchema } },
      },
      async (request) => {
        const ip = clientIpOf(request);
        return deps.controller.monitor({
          tenantId: request.params.tenantId,
          callUuid: request.params.callUuid,
          mode,
          actor: person(request),
          ...(ip === '' ? {} : { ip }),
          requestId: request.context.requestId,
        });
      },
    );
  }
}
