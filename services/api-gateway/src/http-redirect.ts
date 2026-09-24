import { createServer, type Server } from 'node:http';

/**
 * A plain-HTTP listener whose only job is to send a browser to the HTTPS
 * address of the same page. `308` keeps the method, so nothing that arrives
 * here by mistake is silently changed into a GET. The path is not interpreted:
 * only the host the client asked for, and the target's own port, matter.
 */
export function createHttpsRedirect(options: { readonly httpsPort: number }): Server {
  return createServer((request, response) => {
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
