import { timingSafeEqual } from 'node:crypto';

import {
  clientIpOf,
  ProblemError,
  selfActor,
  Type,
  type RequestContext,
  type Server,
} from '@cuc/http';

import { UpstreamError, type UserExtensionLookup } from '../clients.js';
import type { QueueStatus } from '../queue-status.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1, maxLength: 64 }) });
const AgentParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1, maxLength: 64 }),
  /** The agent's extension number. */
  extension: Type.String({ pattern: '^[0-9]{2,6}$' }),
});

const StatusSchema = Type.Union([
  Type.Literal('available'),
  Type.Literal('on_break'),
  Type.Literal('logged_out'),
]);
const StatusBodySchema = Type.Object({ status: StatusSchema });

const AgentViewSchema = Type.Object({
  extension: Type.String(),
  /** Null until the agent has signed in or out on a node since it started. */
  status: Type.Union([StatusSchema, Type.Literal('other'), Type.Null()]),
  /** The queues the extension answers. */
  queueIds: Type.Array(Type.String()),
});

const LiveQueueSchema = Type.Object({
  queueId: Type.String(),
  waiting: Type.Integer(),
  longestWaitingSince: Type.Union([Type.String(), Type.Null()]),
  answered: Type.Integer(),
  callsAnswered: Type.Integer(),
  callsAbandoned: Type.Integer(),
  agents: Type.Array(
    Type.Object({
      extension: Type.String(),
      status: Type.Union([StatusSchema, Type.Literal('other')]),
      activity: Type.Union([
        Type.Literal('waiting'),
        Type.Literal('ringing'),
        Type.Literal('on_call'),
        Type.Literal('idle'),
      ]),
      callsAnswered: Type.Integer(),
      statusSince: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
});

interface SignedRequest {
  readonly context: RequestContext;
}

function person(request: SignedRequest): { id: string; orgId: string } {
  const { actorId, actorType, orgId } = request.context;
  if (actorId === undefined || orgId === undefined) {
    throw ProblemError.unauthorized('Sign in to continue.', { code: 'sign_in_required' });
  }
  if (actorType !== 'user') {
    throw ProblemError.forbidden('Only a signed-in person can change an agent’s status.', {
      code: 'people_only',
    });
  }
  return { id: actorId, orgId };
}

/**
 * S9-13: live queues, and an agent's status (signed in, on a break, signed out), from
 * `queue-status.ts`.
 *
 * - `GET` and `PUT /v1/tenants/{t}/me/agent-status` (`self.settings`, config): a person's own
 *   status as an agent, the same as the `*45`/`*46` feature codes, on every node.
 * - `PUT /v1/tenants/{t}/live-agents/{extension}/status` (`call.control`): a supervisor or
 *   administrator signs an agent in, out, or on a break.
 *
 * Answers: 200 with the agent; 404 `not_an_agent` (the extension answers no queue),
 * `no_linked_extension`; 503 `queue_status_unavailable`, `media_unavailable`, `media_node_failed`.
 */
export function registerQueueStatusRoutes(
  app: Server,
  deps: {
    readonly status: QueueStatus;
    readonly userExtension: UserExtensionLookup;
  },
): void {
  const { status } = deps;

  async function ownExtension(tenantId: string, userId: string): Promise<string> {
    let extension;
    try {
      extension = await deps.userExtension(tenantId, userId);
    } catch (error) {
      if (error instanceof UpstreamError) {
        throw ProblemError.unavailable('Could not look up your extension. Try again shortly.', {
          code: 'extension_lookup_unavailable',
        });
      }
      throw error;
    }
    if (extension === undefined) {
      throw ProblemError.notFound(
        'No extension is linked to your account yet. Ask an administrator to link one.',
        { code: 'no_linked_extension' },
      );
    }
    return extension.number;
  }

  app.get(
    '/v1/tenants/:tenantId/me/agent-status',
    {
      config: { permission: 'self.settings', dataClass: 'config' },
      schema: { params: TenantParamsSchema, response: { 200: AgentViewSchema } },
    },
    async (request) => {
      const me = selfActor(request);
      return status.agent(me.tenantId, await ownExtension(me.tenantId, me.userId));
    },
  );

  app.put(
    '/v1/tenants/:tenantId/me/agent-status',
    {
      config: { permission: 'self.settings', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        body: StatusBodySchema,
        response: { 200: AgentViewSchema },
      },
    },
    async (request) => {
      const me = selfActor(request);
      const ip = clientIpOf(request);
      return status.setAgentStatus({
        tenantId: me.tenantId,
        extension: await ownExtension(me.tenantId, me.userId),
        status: request.body.status,
        actor: { id: me.userId, orgId: me.tenantId },
        own: true,
        ...(ip === '' ? {} : { ip }),
        requestId: request.context.requestId,
      });
    },
  );

  app.put(
    '/v1/tenants/:tenantId/live-agents/:extension/status',
    {
      config: { permission: 'call.control', dataClass: 'config' },
      schema: {
        params: AgentParamsSchema,
        body: StatusBodySchema,
        response: { 200: AgentViewSchema },
      },
    },
    async (request) => {
      const ip = clientIpOf(request);
      return status.setAgentStatus({
        tenantId: request.params.tenantId,
        extension: request.params.extension,
        status: request.body.status,
        actor: person(request),
        own: false,
        ...(ip === '' ? {} : { ip }),
        requestId: request.context.requestId,
      });
    },
  );
}

/**
 * `GET /internal/v1/tenants/{t}/queues` (service token): the tenant's queues as they are now,
 * counts and statuses only, for api-gateway's realtime `queues` topic (S9-13).
 */
export function registerQueueStatusInternalRoutes(
  app: Server,
  deps: { readonly status: QueueStatus; readonly internalServiceToken: string },
): void {
  const { status } = deps;
  const expected = Buffer.from(`Bearer ${deps.internalServiceToken}`);
  const authorized = (header: string | undefined): boolean => {
    const presented = Buffer.from(header ?? '');
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  };

  app.get(
    '/internal/v1/tenants/:tenantId/queues',
    {
      config: { public: true },
      schema: {
        params: TenantParamsSchema,
        response: { 200: Type.Object({ queues: Type.Array(LiveQueueSchema) }) },
      },
    },
    async (request) => {
      if (!authorized(request.headers.authorization)) {
        throw ProblemError.unauthorized('A valid internal service token is required.', {
          code: 'internal_token_invalid',
        });
      }
      return { queues: await status.live(request.params.tenantId) };
    },
  );
}
