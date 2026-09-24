import { ACME_DIRECTORY_URLS, FALLBACK_TERMS_URL } from './domain/acme.js';
import type { AcmeDirectory } from './schema.js';

/** Where a directory publishes the subscriber agreement someone is asked to agree to. */
export interface TermsLookup {
  termsUrl(directory: AcmeDirectory): Promise<string>;
}

const CACHE_MS = 60 * 60_000;

/**
 * Asks Let's Encrypt for the address of its current subscriber agreement (the
 * `meta.termsOfService` of its directory), which changes when the agreement
 * does. It is a link to show a person and a record of what they agreed to, so a
 * lookup that fails falls back to the page where the agreement is always
 * published rather than blocking the screen.
 */
export function createTermsLookup(
  options: {
    readonly fetchImpl?: typeof fetch;
    readonly directoryUrlOverride?: string | undefined;
    readonly now?: () => number;
  } = {},
): TermsLookup {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<AcmeDirectory, { url: string; at: number }>();

  return {
    async termsUrl(directory) {
      const hit = cache.get(directory);
      if (hit !== undefined && now() - hit.at < CACHE_MS) return hit.url;
      try {
        const response = await fetchImpl(
          options.directoryUrlOverride ?? ACME_DIRECTORY_URLS[directory],
          { signal: AbortSignal.timeout(5_000) },
        );
        if (response.ok) {
          const body = (await response.json()) as { meta?: { termsOfService?: unknown } };
          const url = body.meta?.termsOfService;
          if (typeof url === 'string' && /^https:\/\//.test(url)) {
            cache.set(directory, { url, at: now() });
            return url;
          }
        }
      } catch {
        // Fall through: the link is a convenience, not a dependency.
      }
      return FALLBACK_TERMS_URL;
    },
  };
}
