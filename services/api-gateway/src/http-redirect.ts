import { createServer, type Server } from 'node:http';

import { ACME_CHALLENGE_PREFIX, type ChallengeLookup } from './acme-challenge.js';

/**
 * A plain-HTTP listener whose only job is to send a browser to the HTTPS
 * address of the same page. `308` keeps the method, so nothing that arrives
 * here by mistake is silently changed into a GET. The path is not interpreted:
 * only the host the client asked for, and the target's own port, matter.
 */
export function createHttpsRedirect(options: {
  readonly httpsPort: number;
  /** Answers an ACME HTTP-01 challenge, which a CA fetches over plain HTTP and must not be redirected. */
  readonly challenge?: ChallengeLookup;
}): Server {
  return createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (
      options.challenge !== undefined &&
      request.method === 'GET' &&
      path.startsWith(ACME_CHALLENGE_PREFIX)
    ) {
      void options.challenge(path.slice(ACME_CHALLENGE_PREFIX.length)).then((answer) => {
        if (answer === undefined) {
          response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('Not found\n');
          return;
        }
        response.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(answer);
      });
      return;
    }
    const host = (request.headers.host ?? '').replace(/:\d+$/, '');
    // A Host header is client-supplied. Only a plausible hostname is echoed back,
    // so this cannot be turned into a redirect to (or an injection of) anything else.
    if (!/^[A-Za-z0-9.-]+$|^\[[0-9A-Fa-f:]+\]$/.test(host)) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Bad request\n');
      return;
    }
    const port = options.httpsPort === 443 ? '' : `:${String(options.httpsPort)}`;
    response.writeHead(308, {
      location: `https://${host}${port}${request.url ?? '/'}`,
      'cache-control': 'no-store',
    });
    response.end();
  });
}
