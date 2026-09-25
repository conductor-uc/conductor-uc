import { publishAuditEvent } from '@cuc/audit';
import type { DbContext } from '@cuc/db';
import type { Bus } from '@cuc/events';
import {
  clientIpOf,
  ProblemError,
  selfActor,
  Type,
  type RequestContext,
  type Server,
} from '@cuc/http';
import type { Storage } from '@cuc/storage';

import { InvalidEmailSettingsError, InvalidPinError } from '../domain/mailbox.js';
import { PbxClientError, type UserExtensionLookup } from '../pbx-client.js';
import { MailboxNotFoundError, type Mailbox, type MailboxRepo } from '../repo/mailbox.repo.js';
import { MessageNotFoundError, type MessageRepo } from '../repo/message.repo.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });
const MessageParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  messageId: Type.String({ minLength: 1 }),
});

const EmailAfterSchema = Type.Union([
  Type.Literal('keep'),
  Type.Literal('mark_read'),
  Type.Literal('delete'),
]);

/** A person's own mailbox: no mailbox id, no extension id (neither is theirs to name). */
const MyMailboxSchema = Type.Object({
  greetingStatus: Type.Union([
    Type.Literal('none'),
    Type.Literal('pending'),
    Type.Literal('ready'),
  ]),
  unreadCount: Type.Number(),
  notifyEmail: Type.Union([Type.String(), Type.Null()]),
  emailAttachAudio: Type.Boolean(),
  emailAfter: EmailAfterSchema,
});

const MessageSchema = Type.Object({
  id: Type.String(),
  status: Type.Union([Type.Literal('pending'), Type.Literal('ready'), Type.Literal('failed')]),
  callerIdName: Type.Union([Type.String(), Type.Null()]),
  callerIdNumber: Type.Union([Type.String(), Type.Null()]),
  durationMs: Type.Union([Type.Number(), Type.Null()]),
  isRead: Type.Boolean(),
  createdAt: Type.String(),
});

const EmailSettingsBodySchema = Type.Object({
  notifyEmail: Type.Union([Type.String({ maxLength: 254 }), Type.Null()]),
  attachAudio: Type.Boolean(),
  afterEmail: EmailAfterSchema,
});
const ResetPinBodySchema = Type.Object({ pin: Type.String({ minLength: 1 }) });

const noLinkedExtension = () =>
  ProblemError.notFound(
    'No extension is linked to your account yet. Ask an administrator to link one.',
    { code: 'no_linked_extension' },
  );
const noMailbox = () =>
  ProblemError.notFound('Your extension has no voicemail box yet. Ask an administrator.', {
    code: 'no_mailbox',
  });

/**
 * The end-user self-service routes for the caller's own voicemail
 * (`/v1/tenants/{tenantId}/me/voicemail…`, parity 1e). All are
 * `self.voicemail`, `private` data, so H1 keeps every reseller out.
 *
 * "My mailbox" is worked out from the signed context and nothing else: the
 * signed actor id becomes an extension id (pbx-config-service says which
 * extension is linked to that person), and the mailbox is the tenant's mailbox
 * for that extension. No extension id, mailbox id or user id is read from a
 * path, query or body, so there is no parameter to point these routes at
 * someone else's mailbox. A message id in a path is only ever looked up
 * *inside* the caller's own mailbox, so another person's message (or another
 * tenant's) is a 404 exactly like one that does not exist.
 *
 * Writes (delete, PIN, email settings, mark read) and listening are audited.
 */
export function registerMeRoutes(
  app: Server,
  mailboxes: MailboxRepo,
  messages: MessageRepo,
  storage: Storage,
  userExtension: UserExtensionLookup,
  bus: Bus,
): void {
  async function mine(request: {
    readonly context: RequestContext;
    readonly params: { readonly tenantId: string };
  }): Promise<{ readonly ctx: DbContext; readonly mailbox: Mailbox; readonly userId: string }> {
    const me = selfActor(request);
    let extension;
    try {
      extension = await userExtension(me.tenantId, me.userId);
    } catch (error) {
      if (error instanceof PbxClientError) {
        throw ProblemError.unavailable('Could not look up your extension. Try again shortly.');
      }
      throw error;
    }
    if (extension === undefined) throw noLinkedExtension();
    const ctx: DbContext = { ...request.context, tenantId: me.tenantId };
    const mailbox = await mailboxes.findByExtensionId(ctx, extension.extensionId);
    if (mailbox === undefined) throw noMailbox();
    return { ctx, mailbox, userId: me.userId };
  }

  async function summary(ctx: DbContext, mailbox: Mailbox) {
    const ready = await messages.listReady(ctx, mailbox.id);
    return {
      greetingStatus: mailbox.greetingStatus,
      unreadCount: ready.filter((m) => !m.isRead).length,
      notifyEmail: mailbox.notifyEmail,
      emailAttachAudio: mailbox.emailAttachAudio,
      emailAfter: mailbox.emailAfter,
    };
  }

  /** A message of the caller's own mailbox, or a 404 that does not say whether it exists elsewhere. */
  async function myMessage(ctx: DbContext, mailbox: Mailbox, messageId: string) {
    const message = await messages.findById(ctx, messageId);
    if (message?.mailboxId !== mailbox.id) {
      throw ProblemError.notFound('No message with that id in your mailbox.');
    }
    return message;
  }

  async function audit(
    request: { readonly context: RequestContext; readonly ip: string },
    tenantId: string,
    userId: string,
    action: string,
    resource: string,
  ): Promise<void> {
    await publishAuditEvent(bus, {
      actorType: 'user',
      actorId: userId,
      actorOrgId: tenantId,
      targetOrgId: tenantId,
      action,
      resource,
      dataClass: 'private',
      reason: 'self-service',
      ip: clientIpOf(request),
      requestId: request.context.requestId,
    });
  }

  const contract = { permission: 'self.voicemail', dataClass: 'private' } as const;

  app.get(
    '/v1/tenants/:tenantId/me/voicemail',
    {
      config: contract,
      schema: { params: TenantParamsSchema, response: { 200: MyMailboxSchema } },
    },
    async (request) => {
      const { ctx, mailbox } = await mine(request);
      return summary(ctx, mailbox);
    },
  );

  app.get(
    '/v1/tenants/:tenantId/me/voicemail/messages',
    {
      config: contract,
      schema: {
        params: TenantParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(MessageSchema) }) },
      },
    },
    async (request) => {
      const { ctx, mailbox } = await mine(request);
      const rows = (await messages.listReady(ctx, mailbox.id)).map((m) => ({
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

  app.get(
    '/v1/tenants/:tenantId/me/voicemail/messages/:messageId/play-url',
    {
      config: contract,
      schema: {
        params: MessageParamsSchema,
        response: { 200: Type.Object({ url: Type.String() }) },
      },
    },
    async (request) => {
      const { ctx, mailbox, userId } = await mine(request);
      const message = await myMessage(ctx, mailbox, request.params.messageId);
      if (message.status !== 'ready') {
        throw ProblemError.notFound('No message with that id in your mailbox.');
      }
      const url = await storage.forTenant(request.params.tenantId).presignGet(message.objectKey);
      await audit(request, request.params.tenantId, userId, 'voicemail.message.played', message.id);
      return { url };
    },
  );

  app.post(
    '/v1/tenants/:tenantId/me/voicemail/messages/:messageId/read',
    { config: contract, schema: { params: MessageParamsSchema } },
    async (request, reply) => {
      const { ctx, mailbox, userId } = await mine(request);
      const message = await myMessage(ctx, mailbox, request.params.messageId);
      try {
        await messages.markRead(ctx, message.id);
      } catch (error) {
        if (error instanceof MessageNotFoundError) throw ProblemError.notFound(error.message);
        throw error;
      }
      await audit(request, request.params.tenantId, userId, 'voicemail.message.read', message.id);
      return reply.status(204).send();
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/me/voicemail/messages/:messageId',
    { config: contract, schema: { params: MessageParamsSchema } },
    async (request, reply) => {
      const { ctx, mailbox, userId } = await mine(request);
      const message = await myMessage(ctx, mailbox, request.params.messageId);
      try {
        await messages.remove(ctx, message.id);
      } catch (error) {
        if (error instanceof MessageNotFoundError) throw ProblemError.notFound(error.message);
        throw error;
      }
      await audit(
        request,
        request.params.tenantId,
        userId,
        'voicemail.message.deleted',
        message.id,
      );
      return reply.status(204).send();
    },
  );

  /** Sets a new PIN. The PIN is never returned, and never written to an audit event. */
  app.post(
    '/v1/tenants/:tenantId/me/voicemail/reset-pin',
    { config: contract, schema: { params: TenantParamsSchema, body: ResetPinBodySchema } },
    async (request, reply) => {
      const { ctx, mailbox, userId } = await mine(request);
      try {
        await mailboxes.resetPin(ctx, mailbox.id, request.body.pin);
      } catch (error) {
        if (error instanceof InvalidPinError) throw ProblemError.badRequest(error.message);
        if (error instanceof MailboxNotFoundError) throw ProblemError.notFound(error.message);
        throw error;
      }
      await audit(request, request.params.tenantId, userId, 'voicemail.pin.reset', mailbox.id);
      return reply.status(204).send();
    },
  );

  app.put(
    '/v1/tenants/:tenantId/me/voicemail/email-settings',
    {
      config: contract,
      schema: {
        params: TenantParamsSchema,
        body: EmailSettingsBodySchema,
        response: { 200: MyMailboxSchema },
      },
    },
    async (request) => {
      const { ctx, mailbox, userId } = await mine(request);
      let updated;
      try {
        updated = await mailboxes.updateEmailSettings(ctx, mailbox.id, request.body);
      } catch (error) {
        if (error instanceof InvalidEmailSettingsError)
          throw ProblemError.badRequest(error.message);
        if (error instanceof MailboxNotFoundError) throw ProblemError.notFound(error.message);
        throw error;
      }
      // The address is personal data: the audit record names the mailbox, not the address.
      await audit(
        request,
        request.params.tenantId,
        userId,
        'voicemail.email_settings.updated',
        mailbox.id,
      );
      return summary(ctx, updated);
    },
  );
}
