import { timingSafeEqual } from 'node:crypto';

import {
  clientIpOf,
  ProblemError,
  selfActor,
  Type,
  type RequestContext,
  type Server,
} from '@cuc/http';

import type { CallOperations, OperationActor } from '../call-operations.js';

const ParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1, maxLength: 64 }),
  /** A channel uuid from the live calls feed. */
  callUuid: Type.String({ minLength: 1, maxLength: 64, pattern: '^[0-9A-Za-z][0-9A-Za-z-]*$' }),
});
const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1, maxLength: 64 }) });

/** A number to dial, as a phone would: digits, `*`, `#`, and a leading `+`. */
const Dialable = Type.String({ minLength: 1, maxLength: 33, pattern: '^\\+?[0-9*#]{1,32}$' });

const TransferBodySchema = Type.Object({ to: Dialable });
const MyTransferBodySchema = Type.Object({
  to: Dialable,
  /**
   * Attended: the other party waits while the person talks to `to`, then `.../transfer/complete`
   * joins them, or `.../transfer/cancel` goes back. Blind (the default) sends the call straight on.
   */
  attended: Type.Optional(Type.Boolean()),
});
const ParkBodySchema = Type.Object({ parkingLotId: Type.String({ minLength: 1, maxLength: 64 }) });
const DialBodySchema = Type.Object({ to: Dialable });

const HungUpSchema = Type.Object({ result: Type.Literal('hungup') });
const TransferredSchema = Type.Object({
  result: Type.Literal('transferred'),
  /** The leg that was sent on. */
  callUuid: Type.String(),
});
const MyTransferSchema = Type.Union([
  TransferredSchema,
  Type.Object({
    result: Type.Literal('consulting'),
    /** The party waiting while the person talks to the one they called. */
    heldCallUuid: Type.String(),
  }),
]);
const ParkedSchema = Type.Object({
  result: Type.Literal('parked'),
  parkingLotId: Type.String(),
  /** The slot to dial to take the call back. */
  slot: Type.Integer(),
});
const PickedUpSchema = Type.Object({
  result: Type.Literal('picked_up'),
  /** The person's own leg, the call to their phone. */
  callUuid: Type.String(),
});
const DialingSchema = Type.Object({
  result: Type.Literal('dialing'),
  /** The person's own leg, which is now dialing. */
  callUuid: Type.String(),
});

interface SignedRequest {
  readonly context: RequestContext;
}

/** The signed-in person. Only people move live calls: never an API key or a service. */
function person(request: SignedRequest): OperationActor {
  const { actorId, actorType, orgId } = request.context;
  if (actorId === undefined || orgId === undefined) {
    throw ProblemError.unauthorized('Sign in to continue.', { code: 'sign_in_required' });
  }
  if (actorType !== 'user') {
    throw ProblemError.forbidden('Only a signed-in person can change a live call.', {
      code: 'people_only',
    });
  }
  return { id: actorId, orgId };
}

function meta(request: SignedRequest & { ip: string }): { ip?: string; requestId?: string } {
  const ip = clientIpOf(request);
  return { ...(ip === '' ? {} : { ip }), requestId: request.context.requestId };
}

/**
 * S9-12: hang up, transfer, park and pick up live calls (the console's and the attendant
 * console's buttons), and a person's own: hang up, transfer (blind or attended), park, and
 * click-to-call from their own phone (`call-operations.ts`).
 *
 * Everything is `private` (live calls), so no reseller reaches it (H1). The console's routes are
 * `call.control`, across the tenant; a person's are `self.calls`, on a leg of their own extension
 * only, which is worked out from the signed actor, never the request.
 *
 * Answers: 200 with the result; 400 `invalid_destination`; 404 `call_not_found` (no such call in
 * progress in this tenant, or not the person's own), `no_linked_extension`,
 * `parking_lot_not_found`; 403 `people_only` and the guard's refusals; 409 `call_not_answered`,
 * `call_not_connected`, `call_not_ringing`, `own_call`, `parking_lot_full`,
 * `parking_lot_elsewhere`, `transfer_in_progress`, `no_transfer_in_progress`,
 * `consult_not_answered`, `phone_unreachable`, `phone_not_answered`; 503 `call_control_unavailable`,
 * `media_unavailable` (nothing was done) and `media_node_failed`.
 */
export function registerCallOperationRoutes(
  app: Server,
  deps: { readonly operations: CallOperations },
): void {
  const { operations } = deps;
  const anyCall = { permission: 'call.control', dataClass: 'private' } as const;
  const mine = { permission: 'self.calls', dataClass: 'private' } as const;

  app.post(
    '/v1/tenants/:tenantId/calls/:callUuid/hangup',
    { config: anyCall, schema: { params: ParamsSchema, response: { 200: HungUpSchema } } },
    async (request) =>
      operations.hangup({
        tenantId: request.params.tenantId,
        callUuid: request.params.callUuid,
        actor: person(request),
        ...meta(request),
      }),
  );

  app.post(
    '/v1/tenants/:tenantId/calls/:callUuid/transfer',
    {
      config: anyCall,
      schema: {
        params: ParamsSchema,
        body: TransferBodySchema,
        response: { 200: TransferredSchema },
      },
    },
    async (request) =>
      operations.transfer({
        tenantId: request.params.tenantId,
        callUuid: request.params.callUuid,
        to: request.body.to,
        actor: person(request),
        ...meta(request),
      }),
  );

  app.post(
    '/v1/tenants/:tenantId/calls/:callUuid/park',
    {
      config: anyCall,
      schema: { params: ParamsSchema, body: ParkBodySchema, response: { 200: ParkedSchema } },
    },
    async (request) =>
      operations.park({
        tenantId: request.params.tenantId,
        callUuid: request.params.callUuid,
        parkingLotId: request.body.parkingLotId,
        actor: person(request),
        ...meta(request),
      }),
  );

  app.post(
    '/v1/tenants/:tenantId/calls/:callUuid/pickup',
    { config: anyCall, schema: { params: ParamsSchema, response: { 200: PickedUpSchema } } },
    async (request) =>
      operations.pickup({
        tenantId: request.params.tenantId,
        callUuid: request.params.callUuid,
        actor: person(request),
        ...meta(request),
      }),
  );

  /** A person's own leg, from the self-service guard: their own tenant, as a person. */
  function myLeg(request: SignedRequest & { params: { tenantId: string; callUuid: string } }) {
    const me = selfActor(request);
    return {
      tenantId: me.tenantId,
      callUuid: request.params.callUuid,
      own: true,
      actor: { id: me.userId, orgId: me.tenantId },
    };
  }

  app.post(
    '/v1/tenants/:tenantId/me/live-calls/:callUuid/hangup',
    { config: mine, schema: { params: ParamsSchema, response: { 200: HungUpSchema } } },
    async (request) => operations.hangup({ ...myLeg(request), ...meta(request) }),
  );

  app.post(
    '/v1/tenants/:tenantId/me/live-calls/:callUuid/transfer',
    {
      config: mine,
      schema: {
        params: ParamsSchema,
        body: MyTransferBodySchema,
        response: { 200: MyTransferSchema },
      },
    },
    async (request) => {
      const command = { ...myLeg(request), to: request.body.to, ...meta(request) };
      return request.body.attended === true
        ? operations.consult(command)
        : operations.transfer(command);
    },
  );

  app.post(
    '/v1/tenants/:tenantId/me/live-calls/:callUuid/transfer/complete',
    {
      config: mine,
      schema: {
        params: ParamsSchema,
        response: { 200: Type.Object({ result: Type.Literal('transferred') }) },
      },
    },
    async (request) => operations.completeTransfer({ ...myLeg(request), ...meta(request) }),
  );

  app.post(
    '/v1/tenants/:tenantId/me/live-calls/:callUuid/transfer/cancel',
    {
      config: mine,
      schema: {
        params: ParamsSchema,
        response: { 200: Type.Object({ result: Type.Literal('resumed') }) },
      },
    },
    async (request) => operations.cancelTransfer({ ...myLeg(request), ...meta(request) }),
  );

  app.post(
    '/v1/tenants/:tenantId/me/live-calls/:callUuid/park',
    {
      config: mine,
      schema: { params: ParamsSchema, body: ParkBodySchema, response: { 200: ParkedSchema } },
    },
    async (request) =>
      operations.park({
        ...myLeg(request),
        parkingLotId: request.body.parkingLotId,
        ...meta(request),
      }),
  );

  /**
   * S9-18 (G-125): the calls ringing within the person's pickup groups, and picking one up (the
   * one named, or the oldest) on their own phone.
   */
  app.get(
    '/v1/tenants/:tenantId/me/pickup',
    {
      config: mine,
      schema: {
        params: TenantParamsSchema,
        response: {
          200: Type.Object({
            calls: Type.Array(
              Type.Object({
                callUuid: Type.String(),
                extension: Type.String(),
                from: Type.String(),
                startedAt: Type.String(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const me = selfActor(request);
      return {
        calls: await operations.pickupable({
          tenantId: me.tenantId,
          actor: { id: me.userId, orgId: me.tenantId },
        }),
      };
    },
  );

  app.post(
    '/v1/tenants/:tenantId/me/pickup',
    {
      config: mine,
      schema: {
        params: TenantParamsSchema,
        body: Type.Optional(
          Type.Object({
            callUuid: Type.Optional(
              Type.String({ minLength: 1, maxLength: 64, pattern: '^[0-9A-Za-z][0-9A-Za-z-]*$' }),
            ),
          }),
        ),
        response: { 200: PickedUpSchema },
      },
    },
    async (request) => {
      const me = selfActor(request);
      const callUuid = request.body?.callUuid;
      return operations.pickupMine({
        tenantId: me.tenantId,
        actor: { id: me.userId, orgId: me.tenantId },
        ...(callUuid === undefined ? {} : { callUuid }),
        ...meta(request),
      });
    },
  );

  /**
   * Click-to-call: rings the person's own phone, then dials `to` from it, as if they had dialed it
   * there (their caller ID, their tenant's routing and limits). Dialing a parking slot takes back
   * the call parked there.
   */
  app.post(
    '/v1/tenants/:tenantId/me/dial',
    {
      config: mine,
      schema: {
        params: TenantParamsSchema,
        body: DialBodySchema,
        response: { 200: DialingSchema },
      },
    },
    async (request) => {
      const me = selfActor(request);
      return operations.dial({
        tenantId: me.tenantId,
        to: request.body.to,
        actor: { id: me.userId, orgId: me.tenantId },
        ...meta(request),
      });
    },
  );
}

/**
 * `GET /internal/v1/tenants/{t}/pickup-target/{extension}` (S9-18, service token): for `*8` dialed
 * from [extension]'s phone, the caller's leg to intercept (the oldest call ringing within its
 * pickup groups) and the node it is on; 404 `nothing_to_pick_up` when there is none. telephony-
 * config's dialplan asks it and intercepts on the node that holds the call.
 */
export function registerPickupInternalRoutes(
  app: Server,
  deps: { readonly operations: CallOperations; readonly internalServiceToken: string },
): void {
  const expected = Buffer.from(`Bearer ${deps.internalServiceToken}`);
  app.get(
    '/internal/v1/tenants/:tenantId/pickup-target/:extension',
    {
      config: { public: true },
      schema: {
        params: Type.Object({
          tenantId: Type.String({ minLength: 1, maxLength: 64 }),
          extension: Type.String({ pattern: '^[0-9]{2,6}$' }),
        }),
        response: { 200: Type.Object({ callUuid: Type.String(), nodeId: Type.String() }) },
      },
    },
    async (request) => {
      const presented = Buffer.from(request.headers.authorization ?? '');
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        throw ProblemError.unauthorized('A valid internal service token is required.', {
          code: 'internal_token_invalid',
        });
      }
      const target = await deps.operations.pickupTarget(
        request.params.tenantId,
        request.params.extension,
      );
      if (target === undefined) {
        throw ProblemError.notFound('No call is ringing in that pickup group.', {
          code: 'nothing_to_pick_up',
        });
      }
      return target;
    },
  );
}
