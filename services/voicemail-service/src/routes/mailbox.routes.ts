import type { DbContext } from '@cuc/db';
import { ProblemError, Type, type Server, type Static } from '@cuc/http';
import type { Storage } from '@cuc/storage';

import { InvalidExtensionIdError, InvalidPinError } from '../domain/mailbox.js';
import { MailboxAlreadyExistsError, MailboxNotFoundError, type MailboxRepo } from '../repo/mailbox.repo.js';
import { MessageNotFoundError, type MessageRepo } from '../repo/message.repo.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });
const MailboxParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});
const MessageParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
  messageId: Type.String({ minLength: 1 }),
});

const MailboxSchema = Type.Object({
  id: Type.String(),
  extensionId: Type.String(),
  greetingStatus: Type.Union([Type.Literal('none'), Type.Literal('pending'), Type.Literal('ready')]),
  unreadCount: Type.Number(),
});
type MailboxResponse = Static<typeof MailboxSchema>;

const MessageSchema = Type.Object({
  id: Type.String(),
  status: Type.Union([Type.Literal('pending'), Type.Literal('ready'), Type.Literal('failed')]),
  callerIdName: Type.Union([Type.String(), Type.Null()]),
  callerIdNumber: Type.Union([Type.String(), Type.Null()]),
  durationMs: Type.Union([Type.Number(), Type.Null()]),
  isRead: Type.Boolean(),
  createdAt: Type.String(),
});

const CreateMailboxBodySchema = Type.Object({
  extensionId: Type.String({ minLength: 1 }),
  pin: Type.String({ minLength: 1 }),
});
const ResetPinBodySchema = Type.Object({ pin: Type.String({ minLength: 1 }) });

function ctxFor(request: {
  readonly context: DbContext;
  readonly params: { readonly tenantId: string };
}): DbContext {
  return { ...request.context, tenantId: request.params.tenantId };
}

function toProblem(error: unknown): ProblemError {
  if (error instanceof InvalidExtensionIdError) return ProblemError.badRequest(error.message);
  if (error instanceof InvalidPinError) return ProblemError.badRequest(error.message);
  if (error instanceof MailboxAlreadyExistsError) {
    return ProblemError.conflict(error.message, { code: 'mailbox_already_exists' });
  }
  if (error instanceof MailboxNotFoundError) return ProblemError.notFound(error.message);
  if (error instanceof MessageNotFoundError) return ProblemError.notFound(error.message);
  throw error;
}

/**
 * `/v1/tenants/{tenantId}/voicemail/mailboxes` (S2-16; 06's voicemail-service
 * "Public API: mailbox settings, messages (listen via presigned URL,
 * delete), greeting upload."). `voicemail.access` (07 §3.3: "private ...
 * Mailbox owner; grantable per `mailbox`") is a scoped grant elsewhere in
 * this codebase (identity-service's `grant.repo.ts`), but no route anywhere
 * yet actually evaluates a resource-scoped grant at request time — `@cuc/http`'s
 * H1 wall plus role membership is the only enforcement any service in this
 * repo performs today (checked against `did.routes.ts`/`media-asset.routes.ts`
 * before writing this). This route declares the permission/dataClass exactly
 * like every other route (CLAUDE.md rule 3) and does not invent a
 * per-mailbox check nothing else in the codebase has yet either.
 */
export function registerMailboxRoutes(
  app: Server,
  mailboxes: MailboxRepo,
  messages: MessageRepo,
  storage: Storage,
): void {
  async function toResponse(
    ctx: DbContext,
    mailbox: { id: string; extensionId: string; greetingStatus: string },
  ): Promise<MailboxResponse> {
    const ready = await messages.listReady(ctx, mailbox.id);
    return {
      id: mailbox.id,
      extensionId: mailbox.extensionId,
      greetingStatus: mailbox.greetingStatus as MailboxResponse['greetingStatus'],
      unreadCount: ready.filter((m) => !m.isRead).length,
    };
  }

  app.get(
    '/v1/tenants/:tenantId/voicemail/mailboxes',
    {
      config: { permission: 'voicemail.access', dataClass: 'private' },
      schema: {
        params: TenantParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(MailboxSchema) }) },
      },
    },
    async (request) => {
      const ctx = ctxFor(request);
      const rows = await Promise.all((await mailboxes.list(ctx)).map((m) => toResponse(ctx, m)));
      return { rows };
    },
  );

  app.get(
    '/v1/tenants/:tenantId/voicemail/mailboxes/:id',
    {
      config: { permission: 'voicemail.access', dataClass: 'private' },
      schema: { params: MailboxParamsSchema, response: { 200: MailboxSchema } },
    },
    async (request) => {
      const ctx = ctxFor(request);
      const found = await mailboxes.findById(ctx, request.params.id);
      if (found === undefined) throw ProblemError.notFound('No mailbox with that id.');
      return toResponse(ctx, found);
    },
  );

  app.post(
    '/v1/tenants/:tenantId/voicemail/mailboxes',
    {
      config: { permission: 'voicemail.access', dataClass: 'private' },
      schema: {
        params: TenantParamsSchema,
        body: CreateMailboxBodySchema,
        response: { 201: MailboxSchema },
      },
    },
    async (request, reply) => {
      try {
        const ctx = ctxFor(request);
        const created = await mailboxes.create(ctx, request.body);
        return reply.status(201).send(await toResponse(ctx, created));
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.post(
    '/v1/tenants/:tenantId/voicemail/mailboxes/:id/reset-pin',
    {
      config: { permission: 'voicemail.access', dataClass: 'private' },
      schema: { params: MailboxParamsSchema, body: ResetPinBodySchema },
    },
    async (request, reply) => {
      try {
        await mailboxes.resetPin(ctxFor(request), request.params.id, request.body.pin);
      } catch (error) {
        throw toProblem(error);
      }
      return reply.status(204).send();
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/voicemail/mailboxes/:id',
    {
      config: { permission: 'voicemail.access', dataClass: 'private' },
      schema: { params: MailboxParamsSchema },
    },
    async (request, reply) => {
      try {
        await mailboxes.remove(ctxFor(request), request.params.id);
      } catch (error) {
        throw toProblem(error);
      }
      return reply.status(204).send();
    },
  );

  app.post(
    '/v1/tenants/:tenantId/voicemail/mailboxes/:id/greeting/presign',
    {
      config: { permission: 'voicemail.access', dataClass: 'private' },
      schema: {
        params: MailboxParamsSchema,
        response: { 201: Type.Object({ uploadUrl: Type.String(), objectKey: Type.String() }) },
      },
    },
    async (request, reply) => {
      try {
        const result = await mailboxes.presignGreeting(ctxFor(request), request.params.id);
        return reply.status(201).send(result);
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.post(
    '/v1/tenants/:tenantId/voicemail/mailboxes/:id/greeting/complete',
    {
      config: { permission: 'voicemail.access', dataClass: 'private' },
      schema: { params: MailboxParamsSchema, response: { 200: MailboxSchema } },
    },
    async (request) => {
      try {
        const ctx = ctxFor(request);
        return toResponse(ctx, await mailboxes.completeGreeting(ctx, request.params.id));
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.get(
    '/v1/tenants/:tenantId/voicemail/mailboxes/:id/messages',
    {
      config: { permission: 'voicemail.access', dataClass: 'private' },
      schema: {
        params: MailboxParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(MessageSchema) }) },
      },
    },
    async (request) => {
      const rows = (await messages.listReady(ctxFor(request), request.params.id)).map((m) => ({
        id: m.id,
        status: m.status,
        callerIdName: m.callerIdName,
        callerIdNumber: m.callerIdNumber,
        durationMs: m.durationMs,
        isRead: m.isRead,
        createdAt: m.createdAt.toISOString(),
      }));
      return { rows };
    },
  );

  /** A presigned GET, not a byte-proxy — this is a console/API caller with real auth, not FS's `mod_http_cache` (`telephony-config/src/routes/fs.routes.ts`'s own doc comment on why *that* path proxies bytes instead). */
  app.get(
    '/v1/tenants/:tenantId/voicemail/mailboxes/:id/messages/:messageId/play-url',
    {
      config: { permission: 'voicemail.access', dataClass: 'private' },
      schema: { params: MessageParamsSchema, response: { 200: Type.Object({ url: Type.String() }) } },
    },
    async (request) => {
      const ctx = ctxFor(request);
      const message = await messages.findById(ctx, request.params.messageId);
      if (message === undefined || message.mailboxId !== request.params.id || message.status !== 'ready') {
        throw ProblemError.notFound('No ready message with that id in that mailbox.');
      }
      const url = await storage.forTenant(request.params.tenantId).presignGet(message.objectKey);
      return { url };
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/voicemail/mailboxes/:id/messages/:messageId',
    {
      config: { permission: 'voicemail.access', dataClass: 'private' },
      schema: { params: MessageParamsSchema },
    },
    async (request, reply) => {
      try {
        const ctx = ctxFor(request);
        const message = await messages.findById(ctx, request.params.messageId);
        if (message === undefined || message.mailboxId !== request.params.id) {
          throw ProblemError.notFound('No message with that id in that mailbox.');
        }
        await messages.remove(ctx, request.params.messageId);
      } catch (error) {
        throw toProblem(error);
      }
      return reply.status(204).send();
    },
  );
}
