import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server, type Static } from '@cuc/http';
import type { Logger } from '@cuc/logger';
import type { Storage } from '@cuc/storage';

import { evaluatePolicies } from '../domain/policy.js';
import { isRecordingId, spoolFileName } from '../domain/recording.js';
import type { PolicyRepo } from '../repo/policy.repo.js';
import {
  RecordingNotFoundError,
  RecordingStateError,
  type Recording,
  type RecordingRepo,
} from '../repo/recording.repo.js';
import type { SettingsRepo } from '../repo/settings.repo.js';

const DirectionSchema = Type.Union([
  Type.Literal('inbound'),
  Type.Literal('outbound'),
  Type.Literal('internal'),
]);
const OptionalId = Type.Optional(
  Type.Union([Type.String({ minLength: 1, maxLength: 36 }), Type.Null()]),
);

const EvaluateBodySchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  direction: DirectionSchema,
  extensionIds: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 36 }), { maxItems: 8 }),
  ),
  queueId: OptionalId,
  didId: OptionalId,
  /** S5-14: the extension that answered a queue call as its agent. */
  agentId: OptionalId,
});
const DecisionSchema = Type.Object({
  record: Type.Boolean(),
  announce: Type.Boolean(),
  consentAssetId: Type.Union([Type.String(), Type.Null()]),
  policyId: Type.Union([Type.String(), Type.Null()]),
  reason: Type.Union([Type.Literal('policy'), Type.Literal('default')]),
  /** S5-13: feature codes work on this call (start/stop when not recorded, pause/resume when recorded). */
  allowOnDemand: Type.Boolean(),
});

/** S5-13: what telephony-config knows about the call a feature code was pressed on. */
const CallContextSchema = Type.Object({
  direction: DirectionSchema,
  extensionIds: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 36 }), { maxItems: 8 }),
  ),
  queueId: OptionalId,
  didId: OptionalId,
});
const ControlBodySchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  /**
   * A feature code, which toggles: `record` (`*1`) starts or stops an on-demand recording,
   * `pause` (`*2`) pauses or resumes. Exactly one of `code` and `action` is given.
   */
  code: Type.Optional(Type.Union([Type.Literal('record'), Type.Literal('pause')])),
  /**
   * S5-15: an explicit action (the console's and the self-service portal's buttons, through
   * call-control), with the same rules as the codes but no toggling: a Start while a recording
   * runs, a Pause while paused, a Resume while not, is refused rather than undoing someone else's
   * action.
   */
  action: Type.Optional(
    Type.Union([
      Type.Literal('start'),
      Type.Literal('stop'),
      Type.Literal('pause'),
      Type.Literal('resume'),
    ]),
  ),
  /**
   * S5-15: the person who asked, when it was not a phone's feature code. The audit event names
   * them (actor type `user`) instead of the node. call-control takes it from the signed request.
   */
  actor: Type.Optional(
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: 64 }),
      orgId: Type.String({ minLength: 1, maxLength: 64 }),
    }),
  ),
  ip: Type.Optional(Type.String({ maxLength: 64 })),
  requestId: Type.Optional(Type.String({ maxLength: 128 })),
  /** The channel that owns the call's recording (the A leg). */
  callUuid: Type.String({ minLength: 1, maxLength: 64 }),
  /** The recording running on the call now, if any. */
  recordingId: OptionalId,
  nodeId: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()])),
  context: CallContextSchema,
});
const ControlResponseSchema = Type.Object({
  result: Type.Union([
    Type.Literal('started'),
    Type.Literal('stopped'),
    Type.Literal('paused'),
    Type.Literal('resumed'),
    Type.Literal('refused'),
  ]),
  recordingId: Type.Union([Type.String(), Type.Null()]),
  /** The spool file name of the recording acted on. */
  fileName: Type.Union([Type.String(), Type.Null()]),
  /**
   * Why a request was refused: `not_allowed`, `rule_recording`, `not_recording`,
   * `unknown_recording`, `stopped`, and for an explicit action (S5-15) `already_recording`,
   * `already_paused`, `not_paused`.
   */
  reason: Type.Union([Type.String(), Type.Null()]),
});

const RegisterBodySchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  callUuid: Type.String({ minLength: 1, maxLength: 64 }),
  direction: DirectionSchema,
  extensionId: OptionalId,
  peerExtensionId: OptionalId,
  queueId: OptionalId,
  didId: OptionalId,
  policyId: OptionalId,
  nodeId: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()])),
  announced: Type.Boolean(),
});
const RegisterResponseSchema = Type.Object({
  recordingId: Type.String(),
  /** The file name to write in the spool directory. */
  fileName: Type.String(),
});

const IdParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) });
const UploadUrlResponseSchema = Type.Object({
  uploadUrl: Type.String(),
  objectKey: Type.String(),
  contentType: Type.String(),
});
const CompleteBodySchema = Type.Object({
  sizeBytes: Type.Number({ minimum: 0 }),
  /** Hex MD5 of the file, which S3 also computed as the object's ETag; the server compares them. */
  md5: Type.String({ pattern: '^[0-9a-f]{32}$' }),
  /** Hex SHA-256 of the file as the uploader read it (05 §4); stored, not re-derived server-side. */
  sha256: Type.Optional(Type.String({ pattern: '^[0-9a-f]{64}$' })),
  durationMs: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
});
const CompleteResponseSchema = Type.Object({
  id: Type.String(),
  status: Type.String(),
  sizeBytes: Type.Union([Type.Number(), Type.Null()]),
  retentionDate: Type.Union([Type.String(), Type.Null()]),
});
const FailBodySchema = Type.Object({ reason: Type.String({ minLength: 1, maxLength: 128 }) });

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token !== undefined && token !== '' ? token : undefined;
}

export interface InternalRoutesDeps {
  readonly policies: PolicyRepo;
  readonly recordings: RecordingRepo;
  readonly settings: SettingsRepo;
  readonly storage: Storage;
  readonly logger: Logger;
  readonly internalServiceToken: string;
}

/**
 * `/internal/v1/recordings/...` (S5-01, S5-03; 06's recording-service "Internal" list, with the
 * repo's `/complete`-style path segments instead of `:action` suffixes, as voicemail-service does).
 *
 * Two callers, both machines: telephony-config at call setup (`evaluate`, then `register` when
 * the answer is "record"), and the node uploader (`upload-url`, `complete`, `fail`). Same gating
 * as every other internal route here: a shared `INTERNAL_SERVICE_TOKEN` bearer check in the
 * handler (07 §1's precedent), not the permission/dataClass contract.
 */
export function registerInternalRoutes(app: Server, deps: InternalRoutesDeps): void {
  const { policies, recordings, settings, storage, logger } = deps;

  function requireToken(request: { headers: { authorization?: string | undefined } }): void {
    const presented = bearerToken(request.headers.authorization);
    if (presented === undefined || !secretEquals(deps.internalServiceToken, presented)) {
      throw ProblemError.unauthorized('A valid internal service token is required.');
    }
  }

  async function findForUpload(id: string): Promise<Recording> {
    if (!isRecordingId(id)) throw ProblemError.notFound('No recording with that id.');
    const found = await recordings.findByIdForUpload({}, id);
    if (found === undefined) throw ProblemError.notFound('No recording with that id.');
    return found;
  }

  app.post(
    '/internal/v1/recordings/evaluate',
    {
      config: { public: true },
      schema: { body: EvaluateBodySchema, response: { 200: DecisionSchema } },
    },
    async (request): Promise<Static<typeof DecisionSchema>> => {
      requireToken(request);
      const { tenantId, direction, extensionIds, queueId, didId, agentId } = request.body;
      const all = await policies.list({ tenantId });
      return evaluatePolicies(all, {
        direction,
        extensionIds: extensionIds ?? [],
        queueId,
        didId,
        agentId,
      });
    },
  );

  /**
   * S5-13: a feature code pressed during a call (`*1` start/stop on demand, `*2` pause/resume),
   * relayed by telephony-config for the node's Lua script (FreeSWITCH cannot publish audit events
   * itself). Decides whether it is allowed, with the same policies and precedence as call setup,
   * and records the change and its audit event in one transaction before answering, so
   * FreeSWITCH only acts on something already audited. The node then starts, stops, masks or
   * unmasks the recording.
   *
   * - `record` with no running recording: allowed when the deciding rule allows on demand;
   *   registers an on-demand recording (`started`), which then goes through the same spool and
   *   uploader pipeline as any other.
   * - `record` with a running on-demand recording: stops it (`stopped`). A recording a rule started
   *   is never stopped from the phone (`refused`, `rule_recording`): pause it instead.
   * - `pause`: pauses a running recording or resumes a paused one; allowed for an on-demand
   *   recording, or when the deciding rule allows on demand.
   */
  app.post(
    '/internal/v1/recordings/control',
    {
      config: { public: true },
      schema: { body: ControlBodySchema, response: { 200: ControlResponseSchema } },
    },
    async (request): Promise<Static<typeof ControlResponseSchema>> => {
      requireToken(request);
      const { tenantId, code, action, callUuid, recordingId, nodeId, context, actor } =
        request.body;
      if ((code === undefined) === (action === undefined)) {
        throw ProblemError.badRequest('Give exactly one of code and action.');
      }
      const ctx = { tenantId };
      const call = {
        direction: context.direction,
        extensionIds: context.extensionIds ?? [],
        queueId: context.queueId,
        didId: context.didId,
      };
      const refused = (reason: string): Static<typeof ControlResponseSchema> => {
        logger.info(
          { tenantId, callUuid, code, action, reason },
          'recording: recording action refused',
        );
        return { result: 'refused', recordingId: recordingId ?? null, fileName: null, reason };
      };
      // A person (S5-15) is audited as themselves; a feature code, as the node that relayed it.
      const audit = (verb: string) =>
        actor === undefined
          ? {
              actorType: 'node' as const,
              actorId: nodeId ?? 'node',
              actorOrgId: tenantId,
              targetOrgId: tenantId,
              action: verb,
              resource: 'recording',
              dataClass: 'private' as const,
              reason: `feature code on call ${callUuid}`,
            }
          : {
              actorType: 'user' as const,
              actorId: actor.id,
              actorOrgId: actor.orgId,
              targetOrgId: tenantId,
              action: verb,
              resource: 'recording',
              dataClass: 'private' as const,
              reason: `live call control on call ${callUuid}`,
              ...(request.body.ip === undefined ? {} : { ip: request.body.ip }),
              ...(request.body.requestId === undefined
                ? {}
                : { requestId: request.body.requestId }),
            };
      const allowedByRule = async () =>
        evaluatePolicies(await policies.list(ctx), call).allowOnDemand;

      let running: Recording | undefined;
      if (recordingId !== undefined && recordingId !== null) {
        running = isRecordingId(recordingId)
          ? await recordings.findById(ctx, recordingId)
          : undefined;
        if (running === undefined || running.callUuid !== callUuid) {
          return refused('unknown_recording');
        }
      }

      const live = running !== undefined && running.stoppedAt === null ? running : undefined;
      try {
        // S5-15: the explicit actions check what the toggles would have decided by state.
        if (action === 'start') {
          if (live !== undefined) return refused('already_recording');
          if ((await recordings.findRunningOnDemand(ctx, callUuid)) !== undefined) {
            return refused('already_recording');
          }
        } else if (action === 'stop') {
          if (live === undefined) return refused('not_recording');
        }
        if (code === 'record' || action === 'start' || action === 'stop') {
          if (running !== undefined && running.stoppedAt === null) {
            if (!running.onDemand) return refused('rule_recording');
            const stopped = await recordings.stopOnDemand(
              ctx,
              running.id,
              audit('recording.on_demand.stopped'),
            );
            return {
              result: 'stopped',
              recordingId: stopped.id,
              fileName: spoolFileName(stopped.id),
              reason: null,
            };
          }
          const decision = evaluatePolicies(await policies.list(ctx), call);
          if (!decision.allowOnDemand) return refused('not_allowed');
          const started = await recordings.startOnDemand(
            ctx,
            {
              callUuid,
              direction: call.direction,
              extensionId: call.extensionIds[0] ?? null,
              peerExtensionId: call.extensionIds[1] ?? null,
              queueId: call.queueId ?? null,
              didId: call.didId ?? null,
              policyId: decision.policyId,
              nodeId: nodeId ?? null,
              announced: false,
            },
            audit('recording.on_demand.started'),
          );
          return {
            result: 'started',
            recordingId: started.id,
            fileName: spoolFileName(started.id),
            reason: null,
          };
        }

        // code === 'pause', or action 'pause' / 'resume'
        if (running === undefined) return refused('not_recording');
        if (running.stoppedAt !== null) return refused('stopped');
        if (!running.onDemand && !(await allowedByRule())) return refused('not_allowed');
        const toggled = await recordings.togglePause(
          ctx,
          running.id,
          (paused) => audit(paused ? 'recording.paused' : 'recording.resumed'),
          action === 'pause' || action === 'resume' ? action : undefined,
        );
        return {
          result: toggled.paused ? 'paused' : 'resumed',
          recordingId: running.id,
          fileName: spoolFileName(running.id),
          reason: null,
        };
      } catch (error) {
        if (error instanceof RecordingStateError) return refused(error.reason);
        if (error instanceof RecordingNotFoundError) return refused('unknown_recording');
        throw error;
      }
    },
  );

  /**
   * S5-12: every tenant that requires recording (fail closed). telephony-config's reconciliation
   * makes its own copy of the flag match this, repairing a missed `recording.settings.updated`.
   */
  app.get(
    '/internal/v1/recordings/fail-closed-tenants',
    {
      config: { public: true },
      schema: { response: { 200: Type.Object({ tenantIds: Type.Array(Type.String()) }) } },
    },
    async (request) => {
      requireToken(request);
      return { tenantIds: await settings.listFailClosedTenantIds({}) };
    },
  );

  app.post(
    '/internal/v1/recordings/register',
    {
      config: { public: true },
      schema: { body: RegisterBodySchema, response: { 201: RegisterResponseSchema } },
    },
    async (request, reply) => {
      requireToken(request);
      const { tenantId, ...input } = request.body;
      const recording = await recordings.register({ tenantId }, input);
      return reply.status(201).send({ recordingId: recording.id, fileName: `${recording.id}.wav` });
    },
  );

  app.post(
    '/internal/v1/recordings/:id/upload-url',
    {
      config: { public: true },
      schema: { params: IdParamsSchema, response: { 200: UploadUrlResponseSchema } },
    },
    async (request) => {
      requireToken(request);
      const recording = await findForUpload(request.params.id);
      if (recording.status === 'ready' || recording.status === 'expired') {
        throw ProblemError.conflict('That recording has already been uploaded.', {
          code: 'already_uploaded',
        });
      }
      const scoped = storage.forTenant(recording.tenantId);
      await scoped.provisionBucket();
      const uploadUrl = await scoped.presignPut(recording.objectKey, {
        contentType: recording.contentType,
      });
      return { uploadUrl, objectKey: recording.objectKey, contentType: recording.contentType };
    },
  );

  app.post(
    '/internal/v1/recordings/:id/complete',
    {
      config: { public: true },
      schema: {
        params: IdParamsSchema,
        body: CompleteBodySchema,
        response: { 200: CompleteResponseSchema },
      },
    },
    async (request) => {
      requireToken(request);
      const recording = await findForUpload(request.params.id);
      const ctx = { tenantId: recording.tenantId };

      // The uploader says what it sent; the object store says what it holds. They must agree
      // before the recording becomes playable, and the file is deleted from the node only after.
      const head = await storage.forTenant(recording.tenantId).headObject(recording.objectKey);
      if (head === undefined) {
        throw ProblemError.conflict('The recording has not arrived in storage.', {
          code: 'object_missing',
        });
      }
      if (head.sizeBytes !== request.body.sizeBytes) {
        throw ProblemError.conflict('The stored size differs from the file the node sent.', {
          code: 'size_mismatch',
        });
      }
      // A single-part, non-KMS upload's ETag is the MD5. Anything else cannot be compared, and
      // the size check above is then the only server-side proof (logged, never silent).
      if (head.etag !== null && /^[0-9a-f]{32}$/.test(head.etag)) {
        if (head.etag !== request.body.md5) {
          throw ProblemError.conflict('The stored checksum differs from the file the node sent.', {
            code: 'checksum_mismatch',
          });
        }
      } else {
        logger.warn(
          { recordingId: recording.id },
          'recording ETag is not an MD5; verified by size only',
        );
      }

      try {
        const retentionDays = await settings.retentionDays(ctx);
        const done = await recordings.complete(ctx, recording.id, {
          sizeBytes: request.body.sizeBytes,
          durationMs: request.body.durationMs ?? null,
          sha256: request.body.sha256 ?? null,
          retentionDays,
        });
        return {
          id: done.id,
          status: done.status,
          sizeBytes: done.sizeBytes,
          retentionDate: done.retentionDate === null ? null : done.retentionDate.toISOString(),
        };
      } catch (error) {
        if (error instanceof RecordingNotFoundError) throw ProblemError.notFound(error.message);
        if (error instanceof RecordingStateError) {
          throw ProblemError.conflict(error.message, { code: 'invalid_state' });
        }
        throw error;
      }
    },
  );

  app.post(
    '/internal/v1/recordings/:id/fail',
    { config: { public: true }, schema: { params: IdParamsSchema, body: FailBodySchema } },
    async (request, reply) => {
      requireToken(request);
      const recording = await findForUpload(request.params.id);
      await recordings.fail({ tenantId: recording.tenantId }, recording.id, request.body.reason);
      return reply.status(204).send();
    },
  );
}
