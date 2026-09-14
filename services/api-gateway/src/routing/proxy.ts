import {
  ProblemError,
  REQUEST_ID_HEADER,
  signInternalHeaders,
  TRACEPARENT_HEADER,
} from '@cuc/http';
import type { RequestContext, Server } from '@cuc/http';

import { resolveRoute, type RouteEntry } from './route-table.js';

export interface ProxyOptions {
  readonly table: readonly RouteEntry[];
  readonly timeoutMs: number;
  /** Signs the forwarded `x-internal-*` headers — must match what services verify with. */
  readonly internalHeaderSigningSecret: string;
}

/** Response headers that describe the hop, not the payload — never copied through. */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'transfer-encoding',
  'server',
  'x-powered-by',
]);

function contextFields(context: RequestContext): Parameters<typeof signInternalHeaders>[1] {
  return {
    ...(context.actorId === undefined ? {} : { actorId: context.actorId }),
    ...(context.actorType === undefined ? {} : { actorType: context.actorType }),
    ...(context.orgId === undefined ? {} : { orgId: context.orgId }),
    ...(context.orgType === undefined ? {} : { orgType: context.orgType }),
    ...(context.resellerId === undefined ? {} : { resellerId: context.resellerId }),
    ...(context.tenantId === undefined ? {} : { tenantId: context.tenantId }),
  };
}

/**
 * Registers the catch-all reverse proxy: every request that survives auth and
 * rate limiting is forwarded to whichever service `ROUTE_TABLE` names for its
 * path, carrying the resolved actor as signed `x-internal-*` headers.
 *
 * Registered `public: true` at the route-contract level deliberately — the
 * gateway makes no permission or data-class decision of its own (06:
 * "Must not contain business logic or authorization decisions beyond
 * authentication and coarse route-level checks"). The downstream route's own
 * contract, enforced there, is what actually governs the request.
 */
export function registerProxy(app: Server, options: ProxyOptions): void {
  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/v1/*',
    config: { public: true },
    handler: async (request, reply) => {
      const path = new URL(request.url, 'http://internal').pathname;
      const route = resolveRoute(options.table, path);
      if (route === undefined) {
        throw ProblemError.notFound('No service is configured for this path.');
      }

      const target = new URL(request.url, route.target);
      const headers = buildForwardHeaders(request, route, options.internalHeaderSigningSecret);
      const body = hasBody(request) ? JSON.stringify(request.body ?? null) : undefined;
      if (body !== undefined) headers.set('content-type', 'application/json');

      let upstream: Response;
      try {
        upstream = await fetch(target, {
          method: request.method,
          headers,
          ...(body === undefined ? {} : { body }),
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch (error) {
        request.log.warn(
          { err: error, target: target.origin, path },
          'proxy: upstream unreachable',
        );
        throw ProblemError.unavailable('The upstream service did not respond.');
      }

      void reply.status(upstream.status);
      upstream.headers.forEach((value, key) => {
        if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) void reply.header(key, value);
      });

      const payload = Buffer.from(await upstream.arrayBuffer());
      return reply.send(payload);
    },
  });
}

function hasBody(request: { method: string; body?: unknown }): boolean {
  return (
    ['POST', 'PUT', 'PATCH'].includes(request.method) &&
    request.body !== undefined &&
    request.body !== null
  );
}

function buildForwardHeaders(
  request: { headers: Record<string, string | string[] | undefined>; context: RequestContext },
  _route: RouteEntry,
  secret: string,
): Headers {
  const headers = new Headers();
  headers.set('accept', 'application/json');
  headers.set(REQUEST_ID_HEADER, request.context.requestId);

  const traceparent = request.headers[TRACEPARENT_HEADER];
  if (typeof traceparent === 'string') headers.set(TRACEPARENT_HEADER, traceparent);

  const signed = signInternalHeaders(secret, contextFields(request.context));
  for (const [name, value] of Object.entries(signed)) headers.set(name, value);

  return headers;
}
