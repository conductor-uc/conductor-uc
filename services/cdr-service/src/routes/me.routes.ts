import type { DbContext } from '@cuc/db';
import { ProblemError, selfActor, Type, type Server } from '@cuc/http';

import { CDR_DIRECTIONS } from '../domain/cdr.js';
import { PbxClientError, type UserExtensionLookup } from '../pbx-client.js';
import type { CdrRepo } from '../repo/cdr.repo.js';
import { LimitQuerySchema, parseLimit } from './limit.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });

/**
 * What a person may filter their own history by. There is deliberately no
 * `number`, `did`, extension or user here: the number is the caller's own
 * extension, worked out from the signed context, and a query parameter can
 * never replace it (an unknown parameter is ignored, not passed on).
 */
const MyCallsQuerySchema = Type.Object({
  from: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
  direction: Type.Optional(Type.Union(CDR_DIRECTIONS.map((value) => Type.Literal(value)))),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(LimitQuerySchema),
});

/**
 * A call as its participant sees it. Narrower than the admin `Cdr`: no trunk,
 * flow, queue, DID, recording or extension ids, no hangup internals. A person
 * needs who called, when, how long and what happened.
 */
const MyCallSchema = Type.Object({
  id: Type.String(),
  direction: Type.String(),
  startAt: Type.String(),
  answerAt: Type.Union([Type.String(), Type.Null()]),
  endAt: Type.String(),
  durationSec: Type.Number(),
  fromNumber: Type.String(),
  fromName: Type.Union([Type.String(), Type.Null()]),
  toNumber: Type.String(),
  dialedNumber: Type.String(),
  disposition: Type.String(),
});

/**
 * `GET /v1/tenants/{tenantId}/me/calls` (parity 1e): the signed-in person's own
 * call history, `self.history`, `private` data (so H1 walls off resellers).
 *
 * The caller's extension number comes from pbx-config-service by the signed
 * actor id ({@link selfActor}), and is the exact-match `number` filter on the
 * tenant-scoped CDR list. Nothing about whose history it is is read from the
 * request. Ingest does not fill `extension_ids` yet, hence the number filter;
 * a renumbered extension's earlier calls stay under the old number.
 */
export function registerMeRoutes(
  app: Server,
  cdrs: CdrRepo,
  userExtension: UserExtensionLookup,
): void {
  app.get(
    '/v1/tenants/:tenantId/me/calls',
    {
      config: { permission: 'self.history', dataClass: 'private' },
      schema: {
        params: TenantParamsSchema,
        querystring: MyCallsQuerySchema,
        response: {
          200: Type.Object({
            rows: Type.Array(MyCallSchema),
            nextCursor: Type.Union([Type.String(), Type.Null()]),
          }),
        },
      },
    },
    async (request) => {
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
      if (extension === undefined) {
        throw ProblemError.notFound(
          'No extension is linked to your account yet. Ask an administrator to link one.',
          { code: 'no_linked_extension' },
        );
      }

      const ctx: DbContext = { ...request.context, tenantId: me.tenantId };
      const query = request.query;
      const page = await cdrs.list(ctx, {
        number: extension.number,
        ...(query.from === undefined ? {} : { from: new Date(query.from) }),
        ...(query.to === undefined ? {} : { to: new Date(query.to) }),
        ...(query.direction === undefined ? {} : { direction: query.direction }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: parseLimit(query.limit) }),
      });
      return {
        rows: page.rows.map((cdr) => ({
          id: cdr.id,
          direction: cdr.direction,
          startAt: cdr.startAt.toISOString(),
          answerAt: cdr.answerAt === null ? null : cdr.answerAt.toISOString(),
          endAt: cdr.endAt.toISOString(),
          durationSec: cdr.durationSec,
          fromNumber: cdr.fromNumber,
          fromName: cdr.fromName,
          toNumber: cdr.toNumber,
          dialedNumber: cdr.dialedNumber,
          disposition: cdr.disposition,
        })),
        nextCursor: page.nextCursor,
      };
    },
  );
}
