import { readFileSync, statSync } from 'node:fs';
import type { ServerOptions } from 'node:https';
import { join } from 'node:path';
import { createSecureContext, type SecureContext } from 'node:tls';

export interface TlsSettings {
  /** The certificate (and chain) served when a client names no host or an unknown one. */
  readonly certFile?: string | undefined;
  readonly keyFile?: string | undefined;
  /**
   * A directory of certificates for particular hostnames, chosen by the name the
   * client asks for (SNI): `<dir>/<hostname>/fullchain.pem` and `privkey.pem`.
   * A wildcard certificate lives in `_.<domain>`, so `_.example.com` serves
   * `acme.example.com`. Whatever issues and renews them (an ACME client) only
   * has to write files there; a renewed file is picked up without a restart.
   */
  readonly certDir?: string | undefined;
}

/** How long a loaded certificate is trusted before its file is looked at again. */
const RECHECK_MS = 60_000;

const CERT_FILE = 'fullchain.pem';
const KEY_FILE = 'privkey.pem';

/** A hostname a client may send that is safe to use as a directory name. */
const SAFE_HOSTNAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

interface Cached {
  readonly context: SecureContext | undefined;
  readonly mtimeMs: number;
  readonly checkedAt: number;
}

/**
 * The HTTPS options for the edge, or undefined when no certificate is
 * configured (plain HTTP, for development and behind a TLS-terminating proxy).
 *
 * Reading the default certificate happens now, so a missing or unreadable file
 * stops the service at startup and not on the first client. TLS 1.2 is the
 * floor; Node's own cipher defaults are already strong.
 */
export function tlsServerOptions(
  settings: TlsSettings,
  now: () => number = Date.now,
): ServerOptions | undefined {
  const { certFile, keyFile, certDir } = settings;
  if ((certFile === undefined) !== (keyFile === undefined)) {
    throw new Error('TLS_CERT_FILE and TLS_KEY_FILE must be set together, or neither.');
  }
  if (certFile === undefined && certDir === undefined) return undefined;

  const fallback =
    certFile !== undefined && keyFile !== undefined
      ? createSecureContext({ cert: readFileSync(certFile), key: readFileSync(keyFile) })
      : undefined;
  if (fallback === undefined && certDir === undefined) return undefined;

  const cache = new Map<string, Cached>();

  function fromDirectory(dir: string): SecureContext | undefined {
    const certPath = join(dir, CERT_FILE);
    const keyPath = join(dir, KEY_FILE);
    const at = now();
    const known = cache.get(dir);
    if (known !== undefined && at - known.checkedAt < RECHECK_MS) return known.context;
    try {
      const mtimeMs = Math.max(statSync(certPath).mtimeMs, statSync(keyPath).mtimeMs);
      if (known !== undefined && known.mtimeMs === mtimeMs) {
        cache.set(dir, { ...known, checkedAt: at });
        return known.context;
      }
      const context = createSecureContext({
        cert: readFileSync(certPath),
        key: readFileSync(keyPath),
      });
      cache.set(dir, { context, mtimeMs, checkedAt: at });
      return context;
    } catch {
      // No such certificate (or a half-written one, mid-renewal): remembered for
      // a minute so a scan of made-up names does not hit the disk every time.
      cache.set(dir, { context: known?.context, mtimeMs: known?.mtimeMs ?? 0, checkedAt: at });
      return known?.context;
    }
  }

  function contextFor(servername: string): SecureContext | undefined {
    if (certDir === undefined) return undefined;
    const host = servername.toLowerCase();
    if (!SAFE_HOSTNAME.test(host) || host.includes('..')) return undefined;
    const exact = fromDirectory(join(certDir, host));
    if (exact !== undefined) return exact;
    const dot = host.indexOf('.');
    return dot === -1 ? undefined : fromDirectory(join(certDir, `_${host.slice(dot)}`));
  }

  return {
    minVersion: 'TLSv1.2',
    // Node insists on a default key and cert unless SNICallback decides for every
    // connection; the fallback context is what it decides on when none matches.
    ...(certFile !== undefined && keyFile !== undefined
      ? { cert: readFileSync(certFile), key: readFileSync(keyFile) }
      : {}),
    SNICallback: (servername, callback) => {
      const found = contextFor(servername) ?? fallback;
      if (found === undefined) {
        callback(new Error(`No certificate for ${servername}`), undefined);
        return;
      }
      callback(null, found);
    },
  };
}
