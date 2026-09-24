/**
 * Runs the real stack for a person (or a browser tool) to click through: the
 * services of `startStack` on real infrastructure, and one address that serves
 * a built console and forwards `/v1` to the gateway, so the console and the API
 * share an origin (the refresh cookie is `SameSite=Strict` on `/v1/auth`).
 *
 *   node dist/src/serve.js --console ../../apps/console/build/web --port 18090
 *
 * The sign-in page resolves the org from the hostname (G-56/G-61). The address
 * the browser uses is a raw IP, which no org owns, so this forwards a chosen
 * hostname instead: by default the master's `console.{base domain}`; change it
 * while running with `GET /__dev/host?to=acme.platform.test` to sign in as a
 * reseller's own console. `GET /__dev/info` prints the master's sign-in.
 */
import { readFile } from 'node:fs/promises';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { extname, join, resolve } from 'node:path';

import { MASTER_EMAIL, MASTER_PASSWORD, startStack } from './stack.js';

const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const value = args[args.indexOf(`--${name}`) + 1];
  return args.includes(`--${name}`) && value !== undefined ? value : fallback;
};
const root = resolve(option('console', '../../apps/console/build/web'));
const port = Number(option('port', '18090'));

const types: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.css': 'text/css',
  '.ico': 'image/x-icon',
};

const stack = await startStack();
let forwardedHost = `console.${stack.platformBaseDomain}`;
const gateway = new URL(stack.gateway);

const info = () => ({
  masterOrgId: stack.masterOrgId,
  email: MASTER_EMAIL,
  password: MASTER_PASSWORD,
  forwardedHost,
  platformBaseDomain: stack.platformBaseDomain,
  mail: stack.mail,
});

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/__dev/info' || url.pathname === '/__dev/host') {
      const to = url.searchParams.get('to');
      if (url.pathname === '/__dev/host' && to !== null && to !== '') forwardedHost = to;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(info()));
      return;
    }
    if (url.pathname.startsWith('/v1/') || url.pathname === '/healthz') {
      const headers: IncomingHttpHeaders = { ...req.headers, host: forwardedHost };
      const upstream = request(
        {
          host: gateway.hostname,
          port: gateway.port,
          path: req.url,
          method: req.method,
          headers,
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
      return;
    }
    let file = join(root, url.pathname === '/' ? 'index.html' : url.pathname);
    let body: Buffer;
    try {
      body = await readFile(file);
    } catch {
      file = join(root, 'index.html');
      body = await readFile(file);
    }
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  })();
});

server.listen(port, '0.0.0.0', () => {
  // eslint-disable-next-line no-console -- this is a dev command whose output is the point
  console.log(`READY http://0.0.0.0:${String(port)} ${JSON.stringify(info())}`);
});

const shutdown = () => {
  server.close();
  void stack.stop().then(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
