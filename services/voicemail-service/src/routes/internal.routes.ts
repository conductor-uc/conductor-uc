import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server, type Static } from '@cuc/http';

import type { Storage } from '@cuc/storage';

import { spoolFileName } from '../domain/message.js';
import { MailboxNotFoundError, type MailboxRepo } from '../repo/mailbox.repo.js';
import { MessageNotFoundError, type MessageRepo } from '../repo/message.repo.js';

const MailboxParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});
const ExtensionParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  extensionId: Type.String({ minLength: 1 }),
});
const MessageParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
  messageId: Type.String({ minLength: 1 }),
});

const MailboxResponseSchema = Type.Object({
  id: Type.String(),
  extensionId: Type.String(),
  greetingStatus: Type.String(),
  greetingObjectKey: Type.Union([Type.String(), Type.Null()]),
  notifyEmail: Type.Union([Type.String(), Type.Null()]),
  emailAttachAudio: Type.Boolean(),
  emailAfter: Type.String(),
  /** Ready, unread messages: what a message-waiting indicator needs. */
  unreadCount: Type.Number(),
});
const VerifyPinBodySchema = Type.Object({ pin: Type.String({ minLength: 1 }) });
const VerifyPinResponseSchema = Type.Object({ valid: Type.Boolean() });
const CreateMessageBodySchema = Type.Object({
  callerIdName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  callerIdNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
const CreateMessageResponseSchema = Type.Object({
  messageId: Type.String(),
  /** The file to record to in the node's spool (`vm-<messageId>.wav`), which the node uploader delivers (S5-16). */
  fileName: Type.String(),
  objectKey: Type.String(),
});
const MessageResponseSchema = Type.Object({
  id: Type.String(),
  status: Type.String(),
  objectKey: Type.String(),
  callerIdName: Type.Union([Type.String(), Type.Null()]),
  callerIdNumber: Type.Union([Type.String(), Type.Null()]),
  durationMs: Type.Union([Type.Number(), Type.Null()]),
  sizeBytes: Type.Union([Type.Number(), Type.Null()]),
  isRead: Type.Boolean(),
  createdAt: Type.String(),
});

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token !== undefined && token !== '' ? token : undefined;
}

/**
 * `/internal/v1/tenants/{tenantId}/voicemail/...` (S2-16). In support of the
 * FS Lua voicemail app (06's own phrasing), but never called by FS directly
 * — telephony-config is the only thing that talks to FreeSWITCH nodes
 * (CLAUDE.md rule 4), so it calls these on the app's behalf via its own
 * `/fs/voicemail/...` routes, the same shape `/fs/media/...` already uses
 * for pbx-config-service's media assets (S2-07).
 *
 * Creating a message only makes its `pending` row and names its spool file:
 * the audio itself reaches storage through the node uploader and
 * `upload.routes.ts` (S5-16), never through FreeSWITCH or these routes.
 *
 * Same gating as every other internal route in this codebase: a shared
 * `INTERNAL_SERVICE_TOKEN` bearer check inside the handler, not the
 * `permission`/`dataClass` contract (07 §1's precedent — no real
 * service-to-service auth exists yet).
 */
export function registerInternalRoutes(
  app: Server,
  mailboxes: MailboxRepo,
  messages: MessageRepo,
  internalServiceToken: string,
  storage: Storage,
): void {
  function requireToken(request: { headers: { authorization?: string | undefined } }): void {
    const presented = bearerToken(request.headers.authorization);
    if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
      throw ProblemError.unauthorized('A valid internal service token is required.');
    }
  }

  async function toMailboxResponse(
    tenantId: string,
    mailbox: {
      id: string;
      extensionId: string;
      greetingStatus: string;
      greetingObjectKey: string | null;
      notifyEmail: string | null;
      emailAttachAudio: boolean;
      emailAfter: string;
    },
  ): Promise<Static<typeof MailboxResponseSchema>> {
    const ready = await messages.listReady({ tenantId }, mailbox.id);
    return {
      id: mailbox.id,
      extensionId: mailbox.extensionId,
      greetingStatus: mailbox.greetingStatus,
      greetingObjectKey: mailbox.greetingObjectKey,
      notifyEmail: mailbox.notifyEmail,
      emailAttachAudio: mailbox.emailAttachAudio,
      emailAfter: mailbox.emailAfter,
      unreadCount: ready.filter((m) => !m.isRead).length,
    };
  }

  function toMessageResponse(message: {
    id: string;
    status: string;
    objectKey: string;
    callerIdName: string | null;
    callerIdNumber: string | null;
    durationMs: number | null;
    sizeBytes: number | null;
    isRead: boolean;
    createdAt: Date;
  }): Static<typeof MessageResponseSchema> {
    return {
      id: message.id,
      status: message.status,
      objectKey: message.objectKey,
      callerIdName: message.callerIdName,
      callerIdNumber: message.callerIdNumber,
      durationMs: message.durationMs,
      sizeBytes: message.sizeBytes,
      isRead: message.isRead,
      createdAt: message.createdAt.toISOString(),
    };
  }

  app.get(
    '/internal/v1/tenants/:tenantId/voicemail/mailboxes/by-extension/:extensionId',
    {
      config: { public: true },
      schema: { params: ExtensionParamsSchema, response: { 200: MailboxResponseSchema } },
    },
    async (request) => {
      requireToken(request);
      const { tenantId, extensionId } = request.params;
      const mailbox = await mailboxes.findByExtensionId({ tenantId }, extensionId);
      if (mailbox === undefined) throw ProblemError.notFound('That extension has no mailbox.');
      return toMailboxResponse(tenantId, mailbox);
    },
  );

  app.get(
    '/internal/v1/tenants/:tenantId/voicemail/mailboxes/:id',
    {
      config: { public: true },
      schema: { params: MailboxParamsSchema, response: { 200: MailboxResponseSchema } },
    },
    async (request) => {
      requireToken(request);
      const { tenantId, id } = request.params;
      const mailbox = await mailboxes.findById({ tenantId }, id);
      if (mailbox === undefined) throw ProblemError.notFound('No mailbox with that id.');
      return toMailboxResponse(tenantId, mailbox);
    },
  );

  app.post(
    '/internal/v1/tenants/:tenantId/voicemail/mailboxes/:id/verify-pin',
    {
      config: { public: true },
      schema: {
        params: MailboxParamsSchema,
        body: VerifyPinBodySchema,
        response: { 200: VerifyPinResponseSchema },
      },
    },
    async (request) => {
      requireToken(request);
      const { tenantId, id } = request.params;
      try {
        const valid = await mailboxes.verifyPin({ tenantId }, id, request.body.pin);
        return { valid };
      } catch (error) {
        if (error instanceof MailboxNotFoundError) throw ProblemError.notFound(error.message);
        throw error;
      }
    },
  );

  app.post(
    '/internal/v1/tenants/:tenantId/voicemail/mailboxes/:id/messages',
    {
      config: { public: true },
      schema: {
        params: MailboxParamsSchema,
        body: CreateMessageBodySchema,
        response: { 201: CreateMessageResponseSchema },
      },
    },
    async (request, reply) => {
      requireToken(request);
      const { tenantId, id } = request.params;
      const mailbox = await mailboxes.findById({ tenantId }, id);
      if (mailbox === undefined) throw ProblemError.notFound('No mailbox with that id.');

      const { message } = await messages.create({ tenantId }, id, request.body);
      return reply.status(201).send({
        messageId: message.id,
        fileName: spoolFileName(message.id),
        objectKey: message.objectKey,
      });
    },
  );

  app.get(
    '/internal/v1/tenants/:tenantId/voicemail/mailboxes/:id/messages',
    {
      config: { public: true },
      schema: {
        params: MailboxParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(MessageResponseSchema) }) },
      },
    },
    async (request) => {
      requireToken(request);
      const rows = (
        await messages.listReady({ tenantId: request.params.tenantId }, request.params.id)
      ).map(toMessageResponse);
      return { rows };
    },
  );

  /** A single message, `objectKey` included — what telephony-config's `/fs/voicemail/.../audio` byte-proxy (S2-16, the same shape `/fs/media/...` uses for S2-07) resolves before reading it from storage. */
  app.get(
    '/internal/v1/tenants/:tenantId/voicemail/mailboxes/:id/messages/:messageId',
    {
      config: { public: true },
      schema: { params: MessageParamsSchema, response: { 200: MessageResponseSchema } },
    },
    async (request) => {
      requireToken(request);
      const message = await messages.findById(
        { tenantId: request.params.tenantId },
        request.params.messageId,
      );
      if (message === undefined || message.mailboxId !== request.params.id) {
        throw ProblemError.notFound('No message with that id in that mailbox.');
      }
      return toMessageResponse(message);
    },
  );

  /**
   * The recording's bytes (S5-07: what voicemail-to-email attaches). Server-side
   * read through this service's own storage, so no other service holds bucket
   * credentials. The caller checks `sizeBytes` first; nothing here is logged.
   */
  app.get(
    '/internal/v1/tenants/:tenantId/voicemail/mailboxes/:id/messages/:messageId/audio',
    { config: { public: true }, schema: { params: MessageParamsSchema } },
    async (request, reply) => {
      requireToken(request);
      const { tenantId, id, messageId } = request.params;
      const message = await messages.findById({ tenantId }, messageId);
      if (message === undefined || message.mailboxId !== id || message.status !== 'ready') {
        throw ProblemError.notFound('No ready message with that id in that mailbox.');
      }
      const bytes = await storage.forTenant(tenantId).getObject(message.objectKey);
      reply.type('audio/wav');
      return bytes;
    },
  );

  app.post(
    '/internal/v1/tenants/:tenantId/voicemail/mailboxes/:id/messages/:messageId/mark-read',
    {
      config: { public: true },
      schema: { params: MessageParamsSchema, response: { 200: MessageResponseSchema } },
    },
    async (request) => {
      requireToken(request);
      try {
        const message = await messages.markRead(
          { tenantId: request.params.tenantId },
          request.params.messageId,
        );
        return toMessageResponse(message);
      } catch (error) {
        if (error instanceof MessageNotFoundError) throw ProblemError.notFound(error.message);
        throw error;
      }
    },
  );

  app.post(
    '/internal/v1/tenants/:tenantId/voicemail/mailboxes/:id/messages/:messageId/delete',
    { config: { public: true }, schema: { params: MessageParamsSchema } },
    async (request, reply) => {
      requireToken(request);
      try {
        await messages.remove({ tenantId: request.params.tenantId }, request.params.messageId);
      } catch (error) {
        if (error instanceof MessageNotFoundError) throw ProblemError.notFound(error.message);
        throw error;
      }
      return reply.status(204).send();
    },
  );

  app.post(
    '/internal/v1/tenants/:tenantId/voicemail/mailboxes/:id/greeting/presign',
    {
      config: { public: true },
      schema: {
        params: MailboxParamsSchema,
        response: { 201: Type.Object({ uploadUrl: Type.String(), objectKey: Type.String() }) },
      },
    },
    async (request, reply) => {
      requireToken(request);
      try {
        const result = await mailboxes.presignGreeting(
          { tenantId: request.params.tenantId },
          request.params.id,
        );
        return reply.status(201).send(result);
      } catch (error) {
        if (error instanceof MailboxNotFoundError) throw ProblemError.notFound(error.message);
        throw error;
      }
    },
  );

  app.post(
    '/internal/v1/tenants/:tenantId/voicemail/mailboxes/:id/greeting/complete',
    {
      config: { public: true },
      schema: { params: MailboxParamsSchema, response: { 200: MailboxResponseSchema } },
    },
    async (request) => {
      requireToken(request);
      try {
        const mailbox = await mailboxes.completeGreeting(
          { tenantId: request.params.tenantId },
          request.params.id,
        );
        return toMailboxResponse(request.params.tenantId, mailbox);
      } catch (error) {
        if (error instanceof MailboxNotFoundError) throw ProblemError.notFound(error.message);
        throw error;
      }
    },
  );
}
