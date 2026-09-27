import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server } from '@cuc/http';

import type { AgentRepo } from '../repo/agent.repo.js';
import type { ExtensionRepo } from '../repo/extension.repo.js';
import type { QueueTierRepo } from '../repo/queue-tier.repo.js';

const ParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  number: Type.String({ minLength: 1, maxLength: 16, pattern: '^[0-9]+$' }),
});

const ResponseSchema = Type.Object({
  extensionId: Type.String(),
  number: Type.String(),
  /** The queues this extension answers as an agent (its tiers); empty when it is no agent. */
  agentQueueIds: Type.Array(Type.String()),
});

/**
 * `GET /internal/v1/tenants/:tenantId/extensions/by-number/:number` (S5-09): which extension a
 * number is, and which queues it answers as an agent. call-control asks it when a supervisor
 * listens, whispers or barges, to match a grant scoped to an extension or a queue against a live
 * call, whose legs name extensions only by the number the node vouched for (07 §3.3: a grant on
 * `queue:Q1` covers a call where the target is an agent of Q1). Service-token gated like this
 * service's other internal routes; 404 when the tenant has no such extension.
 */
export function registerMonitorScopeInternalRoutes(
  app: Server,
  deps: {
    readonly extensions: ExtensionRepo;
    readonly agents: AgentRepo;
    readonly queueTiers: QueueTierRepo;
    readonly internalServiceToken: string;
  },
): void {
  const { extensions, agents, queueTiers, internalServiceToken } = deps;
  app.get(
    '/internal/v1/tenants/:tenantId/extensions/by-number/:number',
    {
      config: { public: true },
      schema: { params: ParamsSchema, response: { 200: ResponseSchema } },
    },
    async (request) => {
      const header = request.headers.authorization;
      const [scheme, presented] = header?.split(' ') ?? [];
      if (
        scheme !== 'Bearer' ||
        presented === undefined ||
        !secretEquals(internalServiceToken, presented)
      ) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }
      const ctx = { tenantId: request.params.tenantId };
      const extension = await extensions.findByNumber(ctx, request.params.number);
      if (extension === undefined) {
        throw ProblemError.notFound('No extension with that number in that tenant.');
      }
      const agent = await agents.findByExtensionId(ctx, extension.id);
      const tiers = agent === undefined ? [] : await queueTiers.listForAgent(ctx, agent.id);
      return {
        extensionId: extension.id,
        number: extension.number,
        agentQueueIds: [...new Set(tiers.map((tier) => tier.queueId))],
      };
    },
  );

  /**
   * `POST /internal/v1/tenants/:tenantId/monitor-scope` (G-119 (1)): the extension numbers a
   * person's monitoring grants reach, for api-gateway's "calls you supervise" topic. The body names
   * the extensions and queues they are granted on; the answer is those extensions' numbers plus
   * the numbers of every agent of those queues (a grant on a queue covers calls its agents take,
   * 07 §3.3). Ids that are not this tenant's reach nothing.
   */
  app.post(
    '/internal/v1/tenants/:tenantId/monitor-scope',
    {
      config: { public: true },
      schema: {
        params: Type.Object({ tenantId: Type.String({ minLength: 1 }) }),
        body: Type.Object({
          extensionIds: Type.Array(Type.String({ minLength: 1 }), { maxItems: 500 }),
          queueIds: Type.Array(Type.String({ minLength: 1 }), { maxItems: 500 }),
        }),
        response: { 200: Type.Object({ extensions: Type.Array(Type.String()) }) },
      },
    },
    async (request) => {
      const header = request.headers.authorization;
      const [scheme, presented] = header?.split(' ') ?? [];
      if (
        scheme !== 'Bearer' ||
        presented === undefined ||
        !secretEquals(internalServiceToken, presented)
      ) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }
      const ctx = { tenantId: request.params.tenantId };
      const extensionIds = new Set(request.body.extensionIds);
      for (const queueId of new Set(request.body.queueIds)) {
        for (const tier of await queueTiers.listForQueue(ctx, queueId)) {
          const agent = await agents.findById(ctx, tier.agentId);
          if (agent !== undefined) extensionIds.add(agent.extensionId);
        }
      }
      const numbers = new Set<string>();
      for (const id of extensionIds) {
        const extension = await extensions.findById(ctx, id);
        if (extension !== undefined) numbers.add(extension.number);
      }
      return { extensions: [...numbers].sort() };
    },
  );
}
