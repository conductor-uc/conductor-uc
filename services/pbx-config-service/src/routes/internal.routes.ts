import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server, type Static } from '@cuc/http';

import type { DidRepo } from '../repo/did.repo.js';
import type { EmergencyLocationRepo } from '../repo/emergency-location.repo.js';
import type { ExtensionRepo } from '../repo/extension.repo.js';
import { MediaAssetNotFoundError, type MediaAssetRepo } from '../repo/media-asset.repo.js';
import type { RingGroupRepo } from '../repo/ring-group.repo.js';
import type { QueueRepo } from '../repo/queue.repo.js';
import type { AgentRepo } from '../repo/agent.repo.js';
import type { QueueTierRepo } from '../repo/queue-tier.repo.js';

const ParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});
const CredentialResponseSchema = Type.Object({
  extensionId: Type.String(),
  number: Type.String(),
  username: Type.String(),
  ha1: Type.String(),
  ha1b: Type.String(),
  realm: Type.String(),
  callerIdName: Type.Union([Type.String(), Type.Null()]),
  callerIdNumber: Type.Union([Type.String(), Type.Null()]),
  emergencyLocationId: Type.String(),
});
const EmergencyLocationResponseSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  addressLine1: Type.String(),
  addressLine2: Type.Union([Type.String(), Type.Null()]),
  city: Type.String(),
  state: Type.String(),
  postalCode: Type.String(),
  country: Type.String(),
});
const MediaAssetInternalResponseSchema = Type.Object({
  id: Type.String(),
  kind: Type.String(),
  status: Type.String(),
  contentType: Type.String(),
  objectKey: Type.String(),
  /** Null until `status` is `'ready'` — the transcode worker's own `:complete` sets both together. */
  variant8kKey: Type.Union([Type.String(), Type.Null()]),
  variant16kKey: Type.Union([Type.String(), Type.Null()]),
});
const CompleteMediaAssetBodySchema = Type.Object({
  durationMs: Type.Number({ minimum: 0 }),
  sha256: Type.String({ minLength: 1 }),
  sizeBytes: Type.Number({ minimum: 0 }),
  variant8kKey: Type.String({ minLength: 1 }),
  variant16kKey: Type.String({ minLength: 1 }),
});
const FailMediaAssetBodySchema = Type.Object({
  errorMessage: Type.String({ minLength: 1 }),
});
const DidResponseSchema = Type.Object({
  id: Type.String(),
  e164: Type.String(),
  trunkId: Type.String(),
  destinationType: Type.Union([
    Type.Literal('extension'),
    Type.Literal('ring_group'),
    Type.Literal('flow'),
    Type.Literal('queue'),
    Type.Literal('conference'),
    Type.Literal('voicemail'),
  ]),
  destinationId: Type.String(),
});
const RingGroupResponseSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  strategy: Type.String(),
  memberExtensionIds: Type.Array(Type.String()),
  ringTimeoutSeconds: Type.Number(),
  noAnswerDestinationType: Type.Union([Type.String(), Type.Null()]),
  noAnswerDestinationId: Type.Union([Type.String(), Type.Null()]),
});
const QueueResponseSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  strategy: Type.String(),
  mohMediaAssetId: Type.Union([Type.String(), Type.Null()]),
  maxWaitSeconds: Type.Number(),
  announcePosition: Type.Boolean(),
  announceFrequencySeconds: Type.Union([Type.Number(), Type.Null()]),
  noAgentDestinationType: Type.Union([Type.String(), Type.Null()]),
  noAgentDestinationId: Type.Union([Type.String(), Type.Null()]),
});
const AgentResponseSchema = Type.Object({
  id: Type.String(),
  extensionId: Type.String(),
  maxNoAnswer: Type.Number(),
  wrapUpSeconds: Type.Number(),
  rejectDelaySeconds: Type.Number(),
});
const QueueTierResponseSchema = Type.Object({
  id: Type.String(),
  queueId: Type.String(),
  agentId: Type.String(),
  level: Type.Number(),
  position: Type.Number(),
});
const QueueTierParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  queueId: Type.String({ minLength: 1 }),
});

/**
 * `GET /internal/v1/tenants/:tenantId/extensions/:id` (S1-12). What
 * telephony-config calls when `pbx.extension.created`/`.updated` fires, to
 * project the extension's digest credential into OpenSIPs' `subscriber`
 * table — the event itself carries only `{ extensionId, number, displayName
 * }` (06: events stay thin; a consumer that needs more state fetches it),
 * and telephony-config keeps no `sip_credentials` of its own (05 §1.1: no
 * cross-schema joins, so it either builds a read model from events or calls
 * the owner's internal API — this is the latter, same shape as
 * org-service's `/internal/v1/tenants/:id/domain`, S1-09).
 *
 * Same gating as that route: a shared `INTERNAL_SERVICE_TOKEN` bearer check
 * inside the handler rather than the `permission`/`dataClass` contract, since
 * there is no real service-to-service auth yet.
 */
export function registerInternalRoutes(
  app: Server,
  extensions: ExtensionRepo,
  dids: DidRepo,
  emergencyLocations: EmergencyLocationRepo,
  mediaAssets: MediaAssetRepo,
  ringGroups: RingGroupRepo,
  queues: QueueRepo,
  agents: AgentRepo,
  queueTiers: QueueTierRepo,
  internalServiceToken: string,
): void {
  app.get(
    '/internal/v1/tenants/:tenantId/extensions/:id',
    {
      config: { public: true },
      schema: { params: ParamsSchema, response: { 200: CredentialResponseSchema } },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }

      const { tenantId, id } = request.params;
      const credential = await extensions.findCredential({ tenantId }, id);
      if (credential === undefined) {
        throw ProblemError.notFound('No extension with that id in that tenant.');
      }
      return credential satisfies Static<typeof CredentialResponseSchema>;
    },
  );

  /**
   * `GET /internal/v1/tenants/:tenantId/dids/:id` (S2-03) — how
   * telephony-config's `pbx.did.*` consumer re-fetches a DID's current state
   * to project into its own local read model (`pbx.consumer.ts`'s "thin
   * event" pattern, the same shape this file's extension route already
   * serves).
   */
  app.get(
    '/internal/v1/tenants/:tenantId/dids/:id',
    {
      config: { public: true },
      schema: { params: ParamsSchema, response: { 200: DidResponseSchema } },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }

      const { tenantId, id } = request.params;
      const did = await dids.findById({ tenantId }, id);
      if (did === undefined) {
        throw ProblemError.notFound('No DID with that id in that tenant.');
      }
      return {
        id: did.id,
        e164: did.e164,
        trunkId: did.trunkId,
        destinationType: did.destinationType,
        destinationId: did.destinationId,
      } satisfies Static<typeof DidResponseSchema>;
    },
  );

  /**
   * `GET /internal/v1/tenants/:tenantId/emergency-locations/:id` (S2-06;
   * G-1) — how telephony-config resolves a calling extension's
   * `emergencyLocationId` (already on the credential above) to a real,
   * dispatchable address at the moment an emergency call actually needs
   * one. Fetched live, not cached — same reasoning as S2-05's
   * `org-client.ts`'s own `findLimits`: a location correction should take
   * effect on the very next call.
   */
  app.get(
    '/internal/v1/tenants/:tenantId/emergency-locations/:id',
    {
      config: { public: true },
      schema: { params: ParamsSchema, response: { 200: EmergencyLocationResponseSchema } },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }

      const { tenantId, id } = request.params;
      const location = await emergencyLocations.findById({ tenantId }, id);
      if (location === undefined) {
        throw ProblemError.notFound('No emergency location with that id in that tenant.');
      }
      return location satisfies Static<typeof EmergencyLocationResponseSchema>;
    },
  );

  /**
   * `GET /internal/v1/tenants/:tenantId/media-assets/:id` (S2-07) — what the
   * transcode worker calls after `pbx.media_asset.finalize_requested` fires,
   * to learn the raw upload's own `objectKey`/`contentType` (the event
   * itself carries only the id — 06's "thin event" rule). The worker never
   * reads this service's database directly (S2-07's own isolation choice).
   */
  app.get(
    '/internal/v1/tenants/:tenantId/media-assets/:id',
    {
      config: { public: true },
      schema: { params: ParamsSchema, response: { 200: MediaAssetInternalResponseSchema } },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }

      const { tenantId, id } = request.params;
      const asset = await mediaAssets.findById({ tenantId }, id);
      if (asset === undefined) {
        throw ProblemError.notFound('No media asset with that id in that tenant.');
      }
      return {
        id: asset.id,
        kind: asset.kind,
        status: asset.status,
        contentType: asset.contentType,
        objectKey: asset.objectKey,
        variant8kKey: asset.variant8kKey,
        variant16kKey: asset.variant16kKey,
      } satisfies Static<typeof MediaAssetInternalResponseSchema>;
    },
  );

  /**
   * `POST /internal/v1/tenants/:tenantId/media-assets/:id/complete` (S2-07)
   * — the transcode worker's own success callback: both WAV variants are
   * already written to the tenant's bucket (`presignPut`-derived keys the
   * worker minted itself the same way this service's own routes do), this
   * just records the result and flips `status` to `ready`. A synchronous
   * internal call, not a further event: JetStream's own redelivery already
   * covers a transient failure here by retrying the *whole* consumer
   * handler (`@cuc/events`' `createConsumer`), at the cost of redoing the
   * transcode, not losing it.
   */
  app.post(
    '/internal/v1/tenants/:tenantId/media-assets/:id/complete',
    {
      config: { public: true },
      schema: {
        params: ParamsSchema,
        body: CompleteMediaAssetBodySchema,
        response: { 200: MediaAssetInternalResponseSchema },
      },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }

      const { tenantId, id } = request.params;
      try {
        const asset = await mediaAssets.complete({ tenantId }, id, request.body);
        return {
          id: asset.id,
          kind: asset.kind,
          status: asset.status,
          contentType: asset.contentType,
          objectKey: asset.objectKey,
          variant8kKey: asset.variant8kKey,
          variant16kKey: asset.variant16kKey,
        } satisfies Static<typeof MediaAssetInternalResponseSchema>;
      } catch (error) {
        if (error instanceof MediaAssetNotFoundError) throw ProblemError.notFound(error.message);
        throw error;
      }
    },
  );

  /** `POST /internal/v1/tenants/:tenantId/media-assets/:id/fail` (S2-07) — the transcode worker's own failure callback (e.g. `ffmpeg` rejected the upload as not real audio). */
  app.post(
    '/internal/v1/tenants/:tenantId/media-assets/:id/fail',
    {
      config: { public: true },
      schema: {
        params: ParamsSchema,
        body: FailMediaAssetBodySchema,
        response: { 200: MediaAssetInternalResponseSchema },
      },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }

      const { tenantId, id } = request.params;
      try {
        const asset = await mediaAssets.fail({ tenantId }, id, request.body.errorMessage);
        return {
          id: asset.id,
          kind: asset.kind,
          status: asset.status,
          contentType: asset.contentType,
          objectKey: asset.objectKey,
          variant8kKey: asset.variant8kKey,
          variant16kKey: asset.variant16kKey,
        } satisfies Static<typeof MediaAssetInternalResponseSchema>;
      } catch (error) {
        if (error instanceof MediaAssetNotFoundError) throw ProblemError.notFound(error.message);
        throw error;
      }
    },
  );
  /**
   * `GET /internal/v1/tenants/:tenantId/ring-groups/:id` (S2-08) — how
   * telephony-config's `pbx.ring_group.*` consumer re-fetches a ring group's
   * current state to project into its own local read model, the same "thin
   * event" pattern `dids` above already establishes.
   */
  app.get(
    '/internal/v1/tenants/:tenantId/ring-groups/:id',
    {
      config: { public: true },
      schema: { params: ParamsSchema, response: { 200: RingGroupResponseSchema } },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }

      const { tenantId, id } = request.params;
      const ringGroup = await ringGroups.findById({ tenantId }, id);
      if (ringGroup === undefined) {
        throw ProblemError.notFound('No ring group with that id in that tenant.');
      }
      return {
        id: ringGroup.id,
        label: ringGroup.label,
        strategy: ringGroup.strategy,
        memberExtensionIds: [...ringGroup.memberExtensionIds],
        ringTimeoutSeconds: ringGroup.ringTimeoutSeconds,
        noAnswerDestinationType: ringGroup.noAnswerDestinationType,
        noAnswerDestinationId: ringGroup.noAnswerDestinationId,
      } satisfies Static<typeof RingGroupResponseSchema>;
    },
  );

  /**
   * `GET /internal/v1/tenants/:tenantId/queues/:id` (S2-13) — how
   * telephony-config's `pbx.queue.*` consumer re-fetches a queue's current
   * state, the same "thin event" pattern `ring-groups` above establishes.
   */
  app.get(
    '/internal/v1/tenants/:tenantId/queues/:id',
    {
      config: { public: true },
      schema: { params: ParamsSchema, response: { 200: QueueResponseSchema } },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }

      const { tenantId, id } = request.params;
      const queue = await queues.findById({ tenantId }, id);
      if (queue === undefined) {
        throw ProblemError.notFound('No queue with that id in that tenant.');
      }
      return {
        id: queue.id,
        label: queue.label,
        strategy: queue.strategy,
        mohMediaAssetId: queue.mohMediaAssetId,
        maxWaitSeconds: queue.maxWaitSeconds,
        announcePosition: queue.announcePosition,
        announceFrequencySeconds: queue.announceFrequencySeconds,
        noAgentDestinationType: queue.noAgentDestinationType,
        noAgentDestinationId: queue.noAgentDestinationId,
      } satisfies Static<typeof QueueResponseSchema>;
    },
  );

  /** `GET /internal/v1/tenants/:tenantId/agents/:id` (S2-13) — how telephony-config's `pbx.agent.*` consumer re-fetches an agent's current state. */
  app.get(
    '/internal/v1/tenants/:tenantId/agents/:id',
    {
      config: { public: true },
      schema: { params: ParamsSchema, response: { 200: AgentResponseSchema } },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }

      const { tenantId, id } = request.params;
      const agent = await agents.findById({ tenantId }, id);
      if (agent === undefined) {
        throw ProblemError.notFound('No agent with that id in that tenant.');
      }
      return {
        id: agent.id,
        extensionId: agent.extensionId,
        maxNoAnswer: agent.maxNoAnswer,
        wrapUpSeconds: agent.wrapUpSeconds,
        rejectDelaySeconds: agent.rejectDelaySeconds,
      } satisfies Static<typeof AgentResponseSchema>;
    },
  );

  /**
   * `GET /internal/v1/tenants/:tenantId/queues/:queueId/tiers` (S2-13) — how
   * telephony-config's `pbx.queue_tier.*` consumer re-fetches a queue's
   * current tier list after any single tier change (`projection.ts`'s
   * `projectQueueTier` — the whole list, not just the one that changed, the
   * same "re-fetch current state rather than trust the event" discipline,
   * applied at list granularity since a tier has no stable id an event alone
   * identifies it by other than the (queue, agent) pair).
   */
  app.get(
    '/internal/v1/tenants/:tenantId/queues/:queueId/tiers',
    {
      config: { public: true },
      schema: {
        params: QueueTierParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(QueueTierResponseSchema) }) },
      },
    },
    async (request) => {
      const presented = bearerToken(request.headers.authorization);
      if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
        throw ProblemError.unauthorized('A valid internal service token is required.');
      }

      const { tenantId, queueId } = request.params;
      const rows = await queueTiers.listForQueue({ tenantId }, queueId);
      return {
        rows: rows.map(
          (tier) =>
            ({
              id: tier.id,
              queueId: tier.queueId,
              agentId: tier.agentId,
              level: tier.level,
              position: tier.position,
            }) satisfies Static<typeof QueueTierResponseSchema>,
        ),
      };
    },
  );
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token !== undefined && token !== '' ? token : undefined;
}
