import { publishAuditEvent } from '@cuc/audit';
import type { DbContext } from '@cuc/db';
import type { Bus } from '@cuc/events';
import { ProblemError, Type, type Server, type Static } from '@cuc/http';

import { DND_ACTIONS, InvalidCallHandlingError } from '../domain/call-handling.js';
import {
  CallHandlingExtensionNotFoundError,
  type CallHandlingRepo,
} from '../repo/call-handling.repo.js';

const ParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  extensionId: Type.String({ minLength: 1 }),
});

/**
 * Where a call goes. `voicemail` names the extension whose mailbox takes the
 * call (its own when `extensionId` is left out). Shape checks that need the
 * tenant (does the extension exist?) or the wider document (loops) are the
 * repo's, and answer 400.
 */
export const DestinationSchema = Type.Union([
  Type.Object({ type: Type.Literal('extension'), extensionId: Type.String({ minLength: 1 }) }),
  Type.Object({ type: Type.Literal('voicemail'), extensionId: Type.Optional(Type.String()) }),
  Type.Object({ type: Type.Literal('external'), e164: Type.String({ minLength: 1 }) }),
]);

const NullableDestination = Type.Union([DestinationSchema, Type.Null()]);

const CallHandlingBodySchema = Type.Object({
  dnd: Type.Optional(Type.Boolean()),
  dndAction: Type.Optional(Type.Union(DND_ACTIONS.map((a) => Type.Literal(a)))),
  forwardAlways: Type.Optional(NullableDestination),
  forwardBusy: Type.Optional(NullableDestination),
  forwardNoAnswer: Type.Optional(NullableDestination),
  noAnswerSeconds: Type.Optional(Type.Integer()),
  forwardUnreachable: Type.Optional(NullableDestination),
  simultaneousRing: Type.Optional(Type.Array(DestinationSchema)),
});

export const CallHandlingSchema = Type.Object({
  dnd: Type.Boolean(),
  dndAction: Type.Union(DND_ACTIONS.map((a) => Type.Literal(a))),
  forwardAlways: NullableDestination,
  forwardBusy: NullableDestination,
  forwardNoAnswer: NullableDestination,
  noAnswerSeconds: Type.Integer(),
  forwardUnreachable: NullableDestination,
  simultaneousRing: Type.Array(DestinationSchema),
});

function ctxFor(request: {
  readonly context: DbContext;
  readonly params: { readonly tenantId: string };
}): DbContext {
  return { ...request.context, tenantId: request.params.tenantId };
}

function toProblem(error: unknown): ProblemError {
  if (error instanceof InvalidCallHandlingError) {
    return ProblemError.badRequest(error.message, { code: 'invalid_call_handling' });
  }
  if (error instanceof CallHandlingExtensionNotFoundError) {
    return ProblemError.notFound(error.message);
  }
  throw error;
}

/**
 * Registers `GET`/`PUT /v1/tenants/{tenantId}/extensions/{extensionId}/call-handling`
 * (parity 1a). Both are gated by `extension.manage` like the rest of an
 * extension's settings, and the data is `config` (rule 3), so a reseller who
 * may manage a customer's extensions may read and set this too; nothing here
 * is `private` (rule H1). The write is audited.
 */
export function registerCallHandlingRoutes(
  app: Server,
  callHandling: CallHandlingRepo,
  bus: Bus,
): void {
  app.get(
    '/v1/tenants/:tenantId/extensions/:extensionId/call-handling',
    {
      config: { permission: 'extension.manage', dataClass: 'config' },
      schema: { params: ParamsSchema, response: { 200: CallHandlingSchema } },
    },
    async (request) => {
      try {
        return (await callHandling.get(
          ctxFor(request),
          request.params.extensionId,
        )) as unknown as Static<typeof CallHandlingSchema>;
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.put(
    '/v1/tenants/:tenantId/extensions/:extensionId/call-handling',
    {
      config: { permission: 'extension.manage', dataClass: 'config' },
      schema: {
        params: ParamsSchema,
        body: CallHandlingBodySchema,
        response: { 200: CallHandlingSchema },
      },
    },
    async (request) => {
      const { actorId, actorType, orgId } = request.context;
      if (actorId === undefined || actorType === undefined || orgId === undefined) {
        throw ProblemError.unauthorized('An identified actor is required to change call handling.');
      }

      let saved;
      try {
        saved = await callHandling.put(ctxFor(request), request.params.extensionId, request.body);
      } catch (error) {
        throw toProblem(error);
      }

      // The change is already committed with its event, so a failure to
      // publish this audit record does not undo it; it surfaces as an error.
      await publishAuditEvent(bus, {
        actorType,
        actorId,
        actorOrgId: orgId,
        targetOrgId: request.params.tenantId,
        action: 'extension.call_handling.updated',
        resource: request.params.extensionId,
        dataClass: 'config',
        ...(request.ip === undefined ? {} : { ip: request.ip }),
        requestId: request.context.requestId,
      });

      return saved as unknown as Static<typeof CallHandlingSchema>;
    },
  );
}
