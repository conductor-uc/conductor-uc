import fastifyWebsocket from '@fastify/websocket';
import { ProblemError, type Server } from '@cuc/http';
import type { FastifyRequest } from 'fastify';

import type { RealtimeHub } from './hub.js';

export const REALTIME_PATH = '/v1/ws';

export interface RealtimeRouteOptions {
  readonly hub: RealtimeHub;
  /** The console hostnames (`CONSOLE_HOSTNAMES`): browser origins allowed besides the gateway's own. */
  readonly allowedHostnames: readonly string[];
  /** The largest frame a client may send (`REALTIME_MAX_MESSAGE_BYTES`). */
  readonly maxMessageBytes: number;
}

/**
 * `GET /v1/ws`: the realtime hub's endpoint (S5-08).
 *
 * At the HTTP layer the route is `public`: a browser cannot put an access
 * token on a WebSocket request, and a token in the URL would be logged, so the
 * gateway's bearer check (`auth/authenticate.ts`) skips this one path and the
 * hub authenticates the first message instead (`protocol.ts`). What the
 * connection may then receive is decided per topic, each with its own
 * permission and data class (`topics.ts`), by the same rules as every route
 * (`authorize.ts`).
 *
 * Before the upgrade, a browser's `Origin` must be the gateway's own host or a
 * console hostname: this is what stops another site's page from opening a
 * socket with the visitor's credentials (the token is not a cookie, so there
 * is little to steal, but nothing is gained by allowing it). A client that
 * sends no `Origin` is not a browser and is left to the token check. The
 * per-address connection limit is also checked here, so a refused client gets
 * an HTTP answer rather than an upgraded socket. The per-IP request rate limit
 * (`rate-limit/hooks.ts`) applies to the upgrade like any other request.
 */
export async function registerRealtimeRoute(
  app: Server,
  options: RealtimeRouteOptions,
): Promise<void> {
  // Closes the hub's connections with a proper code before the plugin's own
  // pre-close hook closes whatever is left without one.
  app.addHook('preClose', async () => {
    await options.hub.close();
  });

  await app.register(fastifyWebsocket, {
    options: { maxPayload: options.maxMessageBytes },
  });

  app.route({
    method: 'GET',
    url: REALTIME_PATH,
    config: { public: true },
    preValidation: (request, _reply, done) => {
      if (request.ws && !originAllowed(request, options.allowedHostnames)) {
        done(
          ProblemError.forbidden('This origin may not open a live connection.', {
            code: 'origin_not_allowed',
          }),
        );
        return;
      }
      if (request.ws && !options.hub.canAccept(request.ip)) {
        done(
          ProblemError.rateLimited('Too many live connections from this address.', {
            code: 'too_many_connections',
          }),
        );
        return;
      }
      done();
    },
    handler: () => {
      throw new ProblemError(
        426,
        '/problems/upgrade-required',
        'Upgrade required',
        'upgrade_required',
        {
          detail: 'This endpoint only accepts WebSocket connections.',
        },
      );
    },
    wsHandler: (socket, request) => {
      options.hub.accept(socket, {
        ip: request.ip,
        ...(request.context.requestId === undefined
          ? {}
          : { requestId: request.context.requestId }),
      });
    },
  });
}

/**
 * Same origin (the `Origin`'s host is the host the request was sent to, as the
 * gateway sees it through `TRUSTED_PROXIES`) or one of the console hostnames.
 */
export function originAllowed(
  request: Pick<FastifyRequest, 'headers' | 'host'>,
  allowedHostnames: readonly string[],
): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  return url.host === request.host || allowedHostnames.includes(url.hostname);
}
