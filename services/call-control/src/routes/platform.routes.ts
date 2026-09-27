import { clientIpOf, ProblemError, Type, type Server } from '@cuc/http';

import type { NodeActor, NodeDrain } from '../node-drain.js';
import { NodeViewSchema } from './internal.routes.js';

const ParamsSchema = Type.Object({
  nodeId: Type.String({ minLength: 1, maxLength: 64 }),
});

const WeightBodySchema = Type.Object(
  { weight: Type.Integer({ minimum: 1, maximum: 999 }) },
  { additionalProperties: false },
);

const DrainResultSchema = Type.Object({
  ...NodeViewSchema.properties,
  leasesHandedOver: Type.Integer({ minimum: 0 }),
});

const WeightResultSchema = Type.Object({
  ...NodeViewSchema.properties,
  weight: Type.Integer({ minimum: 1, maximum: 999 }),
});

type SignedRequest = Parameters<typeof clientIpOf>[0] & {
  readonly context: {
    readonly actorId?: string;
    readonly actorType?: string;
    readonly orgId?: string;
    readonly requestId: string;
  };
};

function actorOf(request: SignedRequest): NodeActor {
  const { actorId, actorType, orgId, requestId } = request.context;
  if (actorId === undefined || orgId === undefined) {
    throw ProblemError.unauthorized('Sign in to continue.');
  }
  const ip = clientIpOf(request);
  return {
    type: actorType === 'apikey' || actorType === 'service' ? actorType : 'user',
    id: actorId,
    orgId,
    requestId,
    ...(ip === '' ? {} : { ip }),
  };
}

/**
 * S4-12 (G-124): the operations console's actions on an FS node, through api-gateway
 * (`/v1/platform/nodes=call`). `platform.operate` (class `config`), which hard rule H3 reserves
 * to the master whatever a role says; `master_support` does not hold it. Each writes an audit
 * event with its domain event (`node-drain.ts`).
 *
 * - `POST /v1/platform/nodes/{nodeId}/drain` and `/undrain`: as S4-02's internal routes; answer
 *   the node, plus `leasesHandedOver`.
 * - `PUT /v1/platform/nodes/{nodeId}/weight` `{weight: 1..999}`: answers the node, plus `weight`.
 *   The dispatcher takes it a moment later, when telephony-config has applied the event.
 *
 * 404 `node_not_found` for a node that is not in `FS_NODES`.
 */
export function registerPlatformRoutes(app: Server, nodes: NodeDrain): void {
  const notFound = (): ProblemError =>
    ProblemError.notFound('There is no media node with that id.', { code: 'node_not_found' });

  for (const [action, draining] of [
    ['drain', true],
    ['undrain', false],
  ] as const) {
    app.post(
      `/v1/platform/nodes/:nodeId/${action}`,
      {
        config: { permission: 'platform.operate', dataClass: 'config' },
        schema: { params: ParamsSchema, response: { 200: DrainResultSchema } },
      },
      async (request) => {
        const result = await nodes.setDraining(request.params.nodeId, draining, actorOf(request));
        if (result === undefined) throw notFound();
        return { ...result.node, leasesHandedOver: result.leasesHandedOver };
      },
    );
  }

  app.put(
    '/v1/platform/nodes/:nodeId/weight',
    {
      config: { permission: 'platform.operate', dataClass: 'config' },
      schema: {
        params: ParamsSchema,
        body: WeightBodySchema,
        response: { 200: WeightResultSchema },
      },
    },
    async (request) => {
      const node = await nodes.setWeight(
        request.params.nodeId,
        request.body.weight,
        actorOf(request),
      );
      if (node === undefined) throw notFound();
      return { ...node, weight: request.body.weight };
    },
  );
}
