import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Server } from '@cuc/http';

/**
 * CORS for the console (06: "CORS for the console hostnames").
 *
 * Not `@fastify/cors`: that plugin unconditionally registers its own
 * `OPTIONS *` route with no way to give it a `config` — which the route
 * contract guard (`@cuc/http`) rejects outright, by design (CLAUDE.md rule
 * 3). A preflight response carries no tenant data and needs no permission,
 * exactly like `/healthz`, so it gets the same `public: true` route any other
 * infra endpoint does — just one this service registers itself rather than a
 * dependency registering on its behalf.
 */
export function registerCors(app: Server, allowedHostnames: readonly string[]): void {
  app.addHook('onSend', (request, reply, payload, done) => {
    applyOriginHeaders(request, reply, allowedHostnames);
    done(null, payload);
  });

  app.route({
    method: 'OPTIONS',
    url: '/v1/*',
    config: { public: true },
    handler: (request, reply) => {
      applyOriginHeaders(request, reply, allowedHostnames);
      if (isAllowedOrigin(request.headers.origin, allowedHostnames)) {
        reply.header('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE');
        const requestedHeaders = request.headers['access-control-request-headers'];
        if (typeof requestedHeaders === 'string') {
          reply.header('access-control-allow-headers', requestedHeaders);
        }
        reply.header('access-control-max-age', '600');
      }
      return reply.status(204).send();
    },
  });
}

function applyOriginHeaders(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedHostnames: readonly string[],
): void {
  if (request.headers.origin === undefined) return;
  // A cache (browser or CDN) must not serve one origin's preflight answer to
  // another's request for the same URL.
  reply.header('vary', 'origin');
  if (!isAllowedOrigin(request.headers.origin, allowedHostnames)) return;

  reply.header('access-control-allow-origin', request.headers.origin);
  reply.header('access-control-allow-credentials', 'true');
}

function isAllowedOrigin(origin: string | undefined, allowedHostnames: readonly string[]): boolean {
  if (origin === undefined) return false;
  try {
    return allowedHostnames.includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}
