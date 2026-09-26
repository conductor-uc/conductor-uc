import {
  clientIpOf,
  ProblemError,
  selfActor,
  Type,
  type RequestContext,
  type Server,
} from '@cuc/http';

import { UpstreamError, type UserExtensionLookup } from '../clients.js';
import type { RecordingController } from '../recording-control.js';

const ParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1, maxLength: 64 }),
  /** A channel uuid from the live calls feed (either leg of the call). */
  callUuid: Type.String({ minLength: 1, maxLength: 64, pattern: '^[0-9A-Za-z][0-9A-Za-z-]*$' }),
});

const BodySchema = Type.Object({
  /**
   * `start` and `stop` an on-demand recording (only where the call's deciding rule does not record
   * and allows on demand); `pause` and `resume` a recording (an on-demand one, or one a rule that
   * allows on demand started). A recording a rule started is never stopped.
   */
  action: Type.Union([
    Type.Literal('start'),
    Type.Literal('stop'),
    Type.Literal('pause'),
    Type.Literal('resume'),
  ]),
});

const ResultSchema = Type.Object({
  result: Type.Union([
    Type.Literal('started'),
    Type.Literal('stopped'),
    Type.Literal('paused'),
    Type.Literal('resumed'),
  ]),
  recordingId: Type.String(),
  /** The call's recording once the media node has done it; the live feed says the same. */
  recording: Type.Union([Type.Literal('on'), Type.Literal('off'), Type.Literal('paused')]),
});

/** The person behind a request, as the audit event names them. Only people act on a live call. */
interface SignedRequest {
  readonly context: RequestContext;
  readonly ip: string;
}

function person(request: SignedRequest): { id: string; orgId: string } {
  const { actorId, actorType, orgId } = request.context;
  if (actorId === undefined || orgId === undefined) {
    throw ProblemError.unauthorized('Sign in to continue.');
  }
  if (actorType !== 'user') {
    throw ProblemError.forbidden('Only a signed-in person can change a live call’s recording.', {
      code: 'people_only',
    });
  }
  return { id: actorId, orgId };
}

function requestMeta(request: SignedRequest): { ip?: string; requestId?: string } {
  const ip = clientIpOf(request);
  return { ...(ip === '' ? {} : { ip }), requestId: request.context.requestId };
}

/**
 * The record, stop, pause and resume buttons for a live call (S5-15, G-111 (3), G-120), with
 * exactly the rules of the in-call feature codes `*1` and `*2`: recording-service decides and
 * audits (as the person) before anything happens, and call-control carries it out on the media
 * node that holds the call (`recording-control.ts`).
 *
 * Both routes are `private` (they create and change recordings), so no reseller reaches them (H1).
 * Answers: 200 with the result; 404 `call_not_found` (no such call in progress in this tenant, or,
 * self-service, not on the person's own extension); 409 with a neutral code when the call's rules
 * or its state do not allow it (`recording_not_allowed`, `rule_recording`, `not_recording`,
 * `already_recording`, `already_paused`, `not_paused`); 503 when nothing could be done
 * (`recording_unavailable`, `media_unavailable`) or the node did not carry it out
 * (`media_node_failed`).
 */
export function registerRecordingControlRoutes(
  app: Server,
  deps: { readonly controller: RecordingController; readonly userExtension: UserExtensionLookup },
): void {
  const { controller, userExtension } = deps;

  /**
   * `POST /v1/tenants/{tenantId}/calls/{callUuid}/recording`: a supervisor or an administrator,
   * on any live call in the tenant. `recording.control` (G-120).
   */
  app.post(
    '/v1/tenants/:tenantId/calls/:callUuid/recording',
    {
      config: { permission: 'recording.control', dataClass: 'private' },
      schema: { params: ParamsSchema, body: BodySchema, response: { 200: ResultSchema } },
    },
    async (request) => {
      const actor = person(request);
      return controller.control({
        tenantId: request.params.tenantId,
        callUuid: request.params.callUuid,
        action: request.body.action,
        actor,
        ...requestMeta(request),
      });
    },
  );

  /**
   * `POST /v1/tenants/{tenantId}/me/live-calls/{callUuid}/recording`: a person, on a live call on
   * their own extension only (`self.recording`). The extension comes from the signed actor id,
   * never from the request, exactly as the other self-service routes do; a leg that is not theirs
   * is "no such call".
   */
  app.post(
    '/v1/tenants/:tenantId/me/live-calls/:callUuid/recording',
    {
      config: { permission: 'self.recording', dataClass: 'private' },
      schema: { params: ParamsSchema, body: BodySchema, response: { 200: ResultSchema } },
    },
    async (request) => {
      const me = selfActor(request);
      let extension;
      try {
        extension = await userExtension(me.tenantId, me.userId);
      } catch (error) {
        if (error instanceof UpstreamError) {
          throw ProblemError.unavailable('Could not look up your extension. Try again shortly.');
        }
        throw error;
      }
      if (extension === undefined) {
        throw ProblemError.notFound(
          'No extension is linked to your account yet. Ask an administrator to link one.',
          { code: 'no_linked_extension' },
        );
      }
      return controller.control({
        tenantId: me.tenantId,
        callUuid: request.params.callUuid,
        action: request.body.action,
        actor: { id: me.userId, orgId: me.tenantId },
        ownExtension: extension.number,
        ...requestMeta(request),
      });
    },
  );
}
