import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';

import type { Server } from '@cuc/http';

export interface ConsoleHostingOptions {
  /** The built console (`flutter build web` output). */
  readonly dir: string;
  /** Extra origins the console may call besides its own, such as the object store it uploads media to. */
  readonly extraConnectSources?: readonly string[];
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * The Content-Security-Policy the console is served under. Everything comes from
 * its own origin, and nothing may frame it. The two allowances are ones Flutter
 * web needs: `wasm-unsafe-eval` to run CanvasKit, and inline styles for the
 * loading spinner in `index.html`. The build must bundle CanvasKit
 * (`flutter build web --no-web-resources-cdn`), since fetching it from a CDN
 * would need that CDN allowed here.
 */
export function consoleContentSecurityPolicy(extraConnectSources: readonly string[] = []): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${["'self'", ...extraConnectSources].join(' ')}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Serves the built console from the same origin as the API. That is what the
 * refresh cookie's `SameSite=Strict` needs, and it lets the browser be told to
 * trust nothing else. Paths with no file extension are the console's own routes
 * (it uses path URLs), so they get `index.html`. Anything else missing is a 404.
 *
 * Registered after the proxy's `/v1/*`, which is the more specific route, so the
 * API is never shadowed. Files are checked against the real path of the
 * directory, so neither `..` nor a symlink can lead outside it.
 */
export function registerConsoleHosting(app: Server, options: ConsoleHostingOptions): void {
  const policy = consoleContentSecurityPolicy(options.extraConnectSources);
  let root: string | undefined;

  async function rootDir(): Promise<string> {
    root ??= await realpath(options.dir);
    return root;
  }

  async function resolveFile(
    relative: string,
  ): Promise<{ path: string; size: number; mtimeMs: number } | undefined> {
    const base = await rootDir();
    let decoded: string;
    try {
      decoded = decodeURIComponent(relative);
    } catch {
      return undefined;
    }
    if (decoded.includes('\0')) return undefined;
    let real: string;
    try {
      real = await realpath(join(base, decoded));
    } catch {
      return undefined;
    }
    if (real !== base && !real.startsWith(base + sep)) return undefined;
    const info = await stat(real);
    return info.isFile() ? { path: real, size: info.size, mtimeMs: info.mtimeMs } : undefined;
  }

  app.get('/*', { config: { public: true } }, async (request, reply) => {
    const pathname = new URL(request.url, 'http://internal').pathname;
    const wanted = pathname === '/' ? 'index.html' : pathname.slice(1);
    let file = await resolveFile(wanted);
    if (file === undefined && extname(wanted) === '') file = await resolveFile('index.html');
    if (file === undefined) {
      return reply.status(404).type('text/plain; charset=utf-8').send('Not found\n');
    }

    // Weak validators are enough: the size and modification time change with the file.
    const etag = `W/"${file.size.toString(16)}-${Math.trunc(file.mtimeMs).toString(16)}"`;
    void reply.header('etag', etag);
    // The build is not fingerprinted, so it is revalidated every time: cheap with
    // an ETag, and a new release is never masked by a cached old one.
    void reply.header('cache-control', 'no-cache');
    void reply.header('content-security-policy', policy);
    if (request.headers['if-none-match'] === etag) return reply.status(304).send();

    void reply.type(TYPES[extname(file.path).toLowerCase()] ?? 'application/octet-stream');
    void reply.header('content-length', String(file.size));
    return reply.send(createReadStream(file.path));
  });
}
