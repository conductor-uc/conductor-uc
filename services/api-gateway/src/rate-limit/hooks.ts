import { ProblemError } from '@cuc/http';
import type { Server } from '@cuc/http';

import type { RateLimiter } from './limiter.js';

export interface RateLimitHooksOptions {
  readonly ipLimiter: RateLimiter;
  readonly actorLimiter: RateLimiter;
}

function setRateLimitHeaders(
  reply: { header(name: string, value: string): unknown },
  result: { limit: number; remaining: number; resetMs: number },
): void {
  reply.header('x-ratelimit-limit', String(result.limit));
  reply.header('x-ratelimit-remaining', String(result.remaining));
  reply.header('retry-after', String(Math.ceil(result.resetMs / 1000)));
}

/**
 * Registers per-IP and per-actor rate limiting (06: "Rate limits per IP, per
 * user, and per API key").
 *
 * Per-IP runs on `onRequest`, before auth and before the body is parsed, so
 * it protects unauthenticated routes too — `/v1/auth/login` is exactly the
 * route a limiter like this exists for. Per-actor runs on `preHandler`, after
 * {@link registerAuthentication} has resolved `request.context.actorId`, and
 * is skipped entirely for an anonymous request — there is no second identity
 * to charge yet.
 *
 * Both are scoped to `/v1/*`: `/healthz`, `/readyz`, and `/openapi.json` are
 * infrastructure, not API traffic, and must stay reachable for liveness
 * checks regardless of how busy the API is.
 */
export function registerRateLimit(app: Server, options: RateLimitHooksOptions): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/v1/') || request.method === 'OPTIONS') return;

    const result = await options.ipLimiter.consume(request.ip);
    setRateLimitHeaders(reply, result);
    if (!result.allowed) {
      throw ProblemError.rateLimited('Too many requests from this address.', {
        code: 'rate_limit_ip',
      });
    }
  });

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/v1/') || request.method === 'OPTIONS') return;
    if (request.context.actorId === undefined) return;

    const result = await options.actorLimiter.consume(request.context.actorId);
    setRateLimitHeaders(reply, result);
    if (!result.allowed) {
      throw ProblemError.rateLimited('Too many requests from this account.', {
        code: 'rate_limit_actor',
      });
    }
  });
}
