import { publishAuditEvent } from '@cuc/audit';
import type { DbContext } from '@cuc/db';
import type { Bus } from '@cuc/events';
import { clientIpOf, ProblemError, selfActor, Type, type Server, type Static } from '@cuc/http';

import { InvalidCallHandlingError } from '../domain/call-handling.js';
import {
  CallHandlingExtensionNotFoundError,
  type CallHandlingRepo,
} from '../repo/call-handling.repo.js';
import type { Extension, ExtensionRepo } from '../repo/extension.repo.js';
import { CallHandlingBodySchema, CallHandlingSchema } from './call-handling.routes.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });

/**
 * What a person sees of their own extension. Deliberately narrower than the
 * admin `Extension`: no id of anyone else's, no user id, and no emergency
 * location (an administrator's compliance setting, G-1).
 */
const MyExtensionSchema = Type.Object({
  id: Type.String(),
  number: Type.String(),
  displayName: Type.String(),
  callerIdName: Type.Union([Type.String(), Type.Null()]),
  callerIdNumber: Type.Union([Type.String(), Type.Null()]),
  voicemailEnabled: Type.Boolean(),
});

/**
 * Says "you have no extension" plainly. 404 with a stable code, because the
 * person exists and is signed in; there is simply nothing of theirs here yet.
 * The console shows a message for `no_linked_extension` instead of an error.
 */
export function noLinkedExtension(): ProblemError {
  return ProblemError.notFound(
    'No extension is linked to your account yet. Ask an administrator to link one.',
    { code: 'no_linked_extension' },
  );
}

/**
 * The end-user self-service routes for the caller's own extension (parity 1e):
 * `GET /v1/tenants/{tenantId}/me/extension` and `GET|PUT …/me/call-handling`.
 *
 * "Me" is never taken from the request. {@link selfActor} reads the signed
 * actor and tenant, the extension is the one whose `user_id` is that actor
 * ({@link ExtensionRepo.findByUserId}, tenant-scoped), and there is no
 * extension id, user id or number in any path, query or body. So there is no
 * parameter that could point these at someone else's extension. A reseller or
 * master is refused by {@link selfActor}.
 *
 * The call-handling routes call the same repository the admin routes do
 * (`call-handling.repo.ts`), so validation, loop checks and the outbox event
 * that telephony-config projects are one implementation, not two.
 */
export function registerMeRoutes(
  app: Server,
  extensions: ExtensionRepo,
  callHandling: CallHandlingRepo,
  bus: Bus,
): void {
  async function myExtension(request: {
    readonly context: DbContext;
    readonly params: { readonly tenantId: string };
  }): Promise<{ readonly ctx: DbContext; readonly extension: Extension; readonly userId: string }> {
    const me = selfActor(request as Parameters<typeof selfActor>[0]);
    const ctx: DbContext = { ...request.context, tenantId: me.tenantId };
    const extension = await extensions.findByUserId(ctx, me.userId);
    if (extension === undefined) throw noLinkedExtension();
    return { ctx, extension, userId: me.userId };
  }

  app.get(
    '/v1/tenants/:tenantId/me/extension',
    {
      config: { permission: 'self.settings', dataClass: 'config' },
      schema: { params: TenantParamsSchema, response: { 200: MyExtensionSchema } },
    },
    async (request) => {
      const { extension } = await myExtension(request);
      return {
        id: extension.id,
        number: extension.number,
        displayName: extension.displayName,
        callerIdName: extension.callerIdName,
        callerIdNumber: extension.callerIdNumber,
        voicemailEnabled: extension.voicemailEnabled,
      };
    },
  );

  /**
   * The people a person can forward to: every extension's id, number and
   * display name in their own tenant, nothing else. Call handling names another
   * extension by id, and an ordinary user cannot list extensions (that is
   * `extension.manage`), so this is what the picker reads.
   */
  app.get(
    '/v1/tenants/:tenantId/me/directory',
    {
      config: { permission: 'self.settings', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        response: {
          200: Type.Object({
            rows: Type.Array(
              Type.Object({ id: Type.String(), number: Type.String(), displayName: Type.String() }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const { ctx } = await myExtension(request);
      const rows = await extensions.list(ctx);
      return {
        rows: rows.map((e) => ({ id: e.id, number: e.number, displayName: e.displayName })),
      };
    },
  );

  app.get(
    '/v1/tenants/:tenantId/me/call-handling',
    {
      config: { permission: 'self.settings', dataClass: 'config' },
      schema: { params: TenantParamsSchema, response: { 200: CallHandlingSchema } },
    },
    async (request) => {
      const { ctx, extension } = await myExtension(request);
      return (await callHandling.get(ctx, extension.id)) as unknown as Static<
        typeof CallHandlingSchema
      >;
    },
  );

  app.put(
    '/v1/tenants/:tenantId/me/call-handling',
    {
      config: { permission: 'self.settings', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        body: CallHandlingBodySchema,
        response: { 200: CallHandlingSchema },
      },
    },
    async (request) => {
      const { ctx, extension, userId } = await myExtension(request);
      let saved;
      try {
        saved = await callHandling.put(ctx, extension.id, request.body);
      } catch (error) {
        if (error instanceof InvalidCallHandlingError) {
          throw ProblemError.badRequest(error.message, { code: 'invalid_call_handling' });
        }
        if (error instanceof CallHandlingExtensionNotFoundError) {
          throw ProblemError.notFound(error.message);
        }
        throw error;
      }

      // Committed with its event already; a failure to publish the audit
      // record does not undo it and surfaces as an error (same as the admin route).
      await publishAuditEvent(bus, {
        actorType: 'user',
        actorId: userId,
        actorOrgId: request.params.tenantId,
        targetOrgId: request.params.tenantId,
        action: 'extension.call_handling.updated',
        resource: extension.id,
        dataClass: 'config',
        reason: 'self-service',
        ip: clientIpOf(request),
        requestId: request.context.requestId,
      });

      return saved as unknown as Static<typeof CallHandlingSchema>;
    },
  );
}
