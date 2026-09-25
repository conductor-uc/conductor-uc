import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server, type Static } from '@cuc/http';
import type { Logger } from '@cuc/logger';
import type { Storage } from '@cuc/storage';

import { MESSAGE_CONTENT_TYPE, isMessageId } from '../domain/message.js';
import {
  MessageAlreadyReadyError,
  MessageNotFoundError,
  type MessageRepo,
  type VoicemailMessage,
} from '../repo/message.repo.js';

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
});
const FailBodySchema = Type.Object({ reason: Type.String({ minLength: 1, maxLength: 128 }) });

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token !== undefined && token !== '' ? token : undefined;
}

function alreadyUploaded(): ProblemError {
  return ProblemError.conflict('That message has already been uploaded.', {
    code: 'already_uploaded',
  });
}

export interface UploadRoutesDeps {
  readonly messages: MessageRepo;
  readonly storage: Storage;
  readonly logger: Logger;
  readonly internalServiceToken: string;
}

/**
 * `/internal/v1/voicemail/messages/:id/...` (S5-16): the node uploader's side of a voicemail
 * message, the same contract as recording-service's `/internal/v1/recordings/:id/...`
 * (`upload-url`, `complete`, `fail`), so one uploader serves both.
 *
 * `voicemail.lua` records the caller to `vm-<message id>.wav` in the node's spool and leaves
 * it there. The uploader, which holds only that id (no tenant, no storage or database
 * credentials), asks here for a presigned PUT, uploads, and calls `complete`; this service
 * checks the stored object's size and MD5 before the message becomes ready. The lookup by id
 * alone is the one unscoped read (`findByIdForUpload`); everything after it runs scoped to
 * the tenant that row belongs to.
 *
 * Gated like every internal route here: the shared `INTERNAL_SERVICE_TOKEN` bearer check in
 * the handler (07 §1's precedent), not the permission/dataClass contract.
 */
export function registerUploadRoutes(app: Server, deps: UploadRoutesDeps): void {
  const { messages, storage, logger } = deps;

  function requireToken(request: { headers: { authorization?: string | undefined } }): void {
    const presented = bearerToken(request.headers.authorization);
    if (presented === undefined || !secretEquals(deps.internalServiceToken, presented)) {
      throw ProblemError.unauthorized('A valid internal service token is required.');
    }
  }

  async function findForUpload(id: string): Promise<VoicemailMessage> {
    if (!isMessageId(id)) throw ProblemError.notFound('No message with that id.');
    const found = await messages.findByIdForUpload({}, id);
    if (found === undefined) throw ProblemError.notFound('No message with that id.');
    return found;
  }

  app.post(
    '/internal/v1/voicemail/messages/:id/upload-url',
    {
      config: { public: true },
      schema: { params: IdParamsSchema, response: { 200: UploadUrlResponseSchema } },
    },
    async (request): Promise<Static<typeof UploadUrlResponseSchema>> => {
      requireToken(request);
      const message = await findForUpload(request.params.id);
      // The uploader treats this answer as "done": it deletes its (duplicate) spool copy.
      if (message.status === 'ready') throw alreadyUploaded();
      const scoped = storage.forTenant(message.tenantId);
      await scoped.provisionBucket();
      const uploadUrl = await scoped.presignPut(message.objectKey, {
        contentType: MESSAGE_CONTENT_TYPE,
      });
      return { uploadUrl, objectKey: message.objectKey, contentType: MESSAGE_CONTENT_TYPE };
    },
  );

  app.post(
    '/internal/v1/voicemail/messages/:id/complete',
    {
      config: { public: true },
      schema: {
        params: IdParamsSchema,
        body: CompleteBodySchema,
        response: { 200: CompleteResponseSchema },
      },
    },
    async (request): Promise<Static<typeof CompleteResponseSchema>> => {
      requireToken(request);
      const message = await findForUpload(request.params.id);
      if (message.status === 'ready') throw alreadyUploaded();

      // The uploader says what it sent; the object store says what it holds. They must agree
      // before the message is listed (and emailed), and the node deletes its file only after.
      const head = await storage.forTenant(message.tenantId).headObject(message.objectKey);
      if (head === undefined) {
        throw ProblemError.conflict('The message audio has not arrived in storage.', {
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
        logger.warn({ messageId: message.id }, 'message ETag is not an MD5; verified by size only');
      }

      try {
        const done = await messages.complete({ tenantId: message.tenantId }, message.id, {
          sizeBytes: request.body.sizeBytes,
          durationMs: request.body.durationMs ?? null,
          sha256: request.body.sha256 ?? null,
        });
        return { id: done.id, status: done.status, sizeBytes: done.sizeBytes };
      } catch (error) {
        if (error instanceof MessageAlreadyReadyError) throw alreadyUploaded();
        if (error instanceof MessageNotFoundError) throw ProblemError.notFound(error.message);
        throw error;
      }
    },
  );

  app.post(
    '/internal/v1/voicemail/messages/:id/fail',
    { config: { public: true }, schema: { params: IdParamsSchema, body: FailBodySchema } },
    async (request, reply) => {
      requireToken(request);
      const message = await findForUpload(request.params.id);
      await messages.fail({ tenantId: message.tenantId }, message.id, request.body.reason);
      return reply.status(204).send();
    },
  );
}
