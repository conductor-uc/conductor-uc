import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server, type Static } from '@cuc/http';
import type { Logger } from '@cuc/logger';
import type { Storage } from '@cuc/storage';

import { evaluatePolicies } from '../domain/policy.js';
import { isRecordingId } from '../domain/recording.js';
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
});
const DecisionSchema = Type.Object({
  record: Type.Boolean(),
  announce: Type.Boolean(),
  consentAssetId: Type.Union([Type.String(), Type.Null()]),
  policyId: Type.Union([Type.String(), Type.Null()]),
  reason: Type.Union([Type.Literal('policy'), Type.Literal('default')]),
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
      const { tenantId, direction, extensionIds, queueId, didId } = request.body;
      const all = await policies.list({ tenantId });
      return evaluatePolicies(all, { direction, extensionIds: extensionIds ?? [], queueId, didId });
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
