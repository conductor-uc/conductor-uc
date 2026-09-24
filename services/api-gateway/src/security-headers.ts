import type { Server } from '@cuc/http';

export interface SecurityHeaderOptions {
  /** Ask browsers to use HTTPS only, for this long, on this host and its subdomains. 0 leaves it off. */
  readonly hstsMaxAgeSeconds: number;
}

/**
 * Headers every response from the edge carries, whatever produced it.
 *
 * `Strict-Transport-Security` is only meaningful (and only honoured) over
 * HTTPS, so it is sent when the request arrived that way. API responses are
 * never cached: they carry tokens, configuration and, for a phone, a SIP
 * password. A route that sets its own `Cache-Control` keeps it.
 */
export function registerSecurityHeaders(app: Server, options: SecurityHeaderOptions): void {
  app.addHook('onSend', (request, reply, payload, done) => {
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('referrer-policy', 'no-referrer');
    void reply.header('x-frame-options', 'DENY');
    void reply.header('cross-origin-opener-policy', 'same-origin');
    void reply.header('permissions-policy', 'camera=(), geolocation=(), payment=()');
    if (options.hstsMaxAgeSeconds > 0 && request.protocol === 'https') {
      void reply.header(
        'strict-transport-security',
        `max-age=${String(options.hstsMaxAgeSeconds)}; includeSubDomains`,
      );
    }
    if (request.url.startsWith('/v1/') && reply.getHeader('cache-control') === undefined) {
      void reply.header('cache-control', 'no-store');
    }
    done(null, payload);
  });
}
