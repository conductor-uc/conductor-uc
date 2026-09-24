import { createSecureContext, type SecureContext } from 'node:tls';

/** The certificate for a hostname a client asked for, or undefined when there is none. */
export type CertificateSource = (servername: string) => Promise<SecureContext | undefined>;

const SAFE_HOSTNAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

interface Entry {
  readonly context: SecureContext | undefined;
  readonly checkedAt: number;
}

/**
 * Console certificates from org-service (G-105), which keeps them in its
 * database and renews them in the background. The private key crosses only the
 * internal route and stays in memory here.
 *
 * A name is looked up at most once a minute. A failed lookup, or a renewal that
 * cannot be read, leaves the certificate already held in use; a name org-service
 * has nothing for is remembered as such for the same minute, so a scan of made-up
 * hostnames does not become a scan of org-service. Only certificates for the
 * console are used: a SIP certificate is never presented on the web edge.
 */
export function createOrgCertificateSource(options: {
  readonly orgServiceUrl: string;
  readonly internalServiceToken: string | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly recheckMs?: number;
}): CertificateSource {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const recheckMs = options.recheckMs ?? 60_000;
  const base = options.orgServiceUrl.replace(/\/+$/, '');
  const cache = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<SecureContext | undefined>>();

  async function fetchContext(host: string, held: SecureContext | undefined) {
    try {
      const response = await fetchImpl(
        `${base}/internal/v1/certificates/${encodeURIComponent(host)}`,
        {
          headers: { authorization: `Bearer ${options.internalServiceToken ?? ''}` },
          signal: AbortSignal.timeout(3_000),
        },
      );
      if (response.status === 404) return undefined;
      if (!response.ok) return held;
      const body = (await response.json()) as {
        purpose?: unknown;
        certificate?: unknown;
        privateKey?: unknown;
      };
      if (
        body.purpose !== 'console' ||
        typeof body.certificate !== 'string' ||
        typeof body.privateKey !== 'string'
      ) {
        return undefined;
      }
      return createSecureContext({ cert: body.certificate, key: body.privateKey });
    } catch {
      return held;
    }
  }

  return async (servername) => {
    if (options.internalServiceToken === undefined) return undefined;
    const host = servername.toLowerCase();
    if (!SAFE_HOSTNAME.test(host) || host.includes('..')) return undefined;
    const known = cache.get(host);
    if (known !== undefined && now() - known.checkedAt < recheckMs) return known.context;
    const pending = inFlight.get(host);
    if (pending !== undefined) return pending;
    const lookup = fetchContext(host, known?.context)
      .then((context) => {
        cache.set(host, { context, checkedAt: now() });
        return context;
      })
      .finally(() => inFlight.delete(host));
    inFlight.set(host, lookup);
    return lookup;
  };
}
