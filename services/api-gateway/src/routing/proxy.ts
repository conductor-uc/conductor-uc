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

/**
 * The identity to sign for a forwarded request, plus the client's address
 * (G-113): services record it in audit events and sessions, since their own
 * view of the connection is this gateway. `ip` is the socket's address, or the
 * one a `TRUSTED_PROXIES` proxy forwarded.
 */
function contextFields(
  context: RequestContext,
  ip: string | undefined,
): Parameters<typeof signInternalHeaders>[1] {
  return {
    ...(context.actorId === undefined ? {} : { actorId: context.actorId }),
    ...(context.actorType === undefined ? {} : { actorType: context.actorType }),
    ...(context.orgId === undefined ? {} : { orgId: context.orgId }),
    ...(context.orgType === undefined ? {} : { orgType: context.orgType }),
    ...(context.resellerId === undefined ? {} : { resellerId: context.resellerId }),
    ...(context.tenantId === undefined ? {} : { tenantId: context.tenantId }),
    ...(ip === undefined ? {} : { clientIp: ip }),
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
      const headers = buildForwardHeaders(
        request,
        route,
        options.internalHeaderSigningSecret,
        path,
      );
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
        const name = key.toLowerCase();
        // Set-Cookie is added below: `forEach` folds several into one string.
        if (!HOP_BY_HOP_HEADERS.has(name) && name !== 'set-cookie') void reply.header(key, value);
      });
      const cookies = upstream.headers.getSetCookie();
      if (cookies.length > 0) void reply.header('set-cookie', cookies);

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

/**
 * Only the auth endpoints read the refresh cookie (its `Path` is `/v1/auth`),
 * so it is forwarded there and nowhere else, along with the header that asks
 * for cookie-only transport.
 */
const AUTH_PREFIX = '/v1/auth';

/**
 * A desk phone fetching its settings has no session: it proves who it is with
 * HTTP Basic credentials, which pbx-config-service checks itself. So this one
 * prefix, and no other, gets the caller's `Authorization` header forwarded;
 * everywhere else the gateway has already authenticated the caller and passes
 * on signed internal headers instead.
 */
const PROVISION_PREFIX = '/v1/public/provision/';
const REFRESH_TRANSPORT_HEADER = 'x-refresh-transport';

function buildForwardHeaders(
  request: {
    headers: Record<string, string | string[] | undefined>;
    context: RequestContext;
    ip?: string;
  },
  _route: RouteEntry,
  secret: string,
  path: string,
): Headers {
  const headers = new Headers();
  headers.set('accept', 'application/json');
  headers.set(REQUEST_ID_HEADER, request.context.requestId);

  const traceparent = request.headers[TRACEPARENT_HEADER];
  if (typeof traceparent === 'string') headers.set(TRACEPARENT_HEADER, traceparent);

  // Sessions record what they were opened from; without this, identity-service
  // would see the proxy's own User-Agent. The client's address travels signed,
  // in the context headers below.
  const userAgent = request.headers['user-agent'];
  if (typeof userAgent === 'string') headers.set('user-agent', userAgent);

  if (path === AUTH_PREFIX || path.startsWith(`${AUTH_PREFIX}/`)) {
    const cookie = request.headers['cookie'];
    if (typeof cookie === 'string') headers.set('cookie', cookie);
    const transport = request.headers[REFRESH_TRANSPORT_HEADER];
    if (typeof transport === 'string') headers.set(REFRESH_TRANSPORT_HEADER, transport);
    // Which console the browser was on, so identity-service can tell which
    // org's users sign in there (G-56). Always the gateway's own view of the
    // Host header, never a value the client supplied as `x-forwarded-host`.
    const host = request.headers['host'];
    if (typeof host === 'string') headers.set('x-forwarded-host', host);
  }

  if (path.startsWith(PROVISION_PREFIX)) {
    const authorization = request.headers['authorization'];
    if (typeof authorization === 'string') headers.set('authorization', authorization);
  }

  const signed = signInternalHeaders(secret, contextFields(request.context, request.ip));
  for (const [name, value] of Object.entries(signed)) headers.set(name, value);

  return headers;
}
