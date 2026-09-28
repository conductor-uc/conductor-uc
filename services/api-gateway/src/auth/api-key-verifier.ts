import { createHash } from 'node:crypto';

import { ProblemError } from '@cuc/http';

/** Who a usable API key acts for (S1-08, G-14). */
export interface ApiKeyIdentity {
  readonly keyId: string;
  readonly orgId: string;
  readonly orgType: 'master' | 'reseller' | 'tenant';
  readonly resellerId: string | null;
}

/** The key is malformed, unknown, revoked or expired: all alike to the caller. */
export class InvalidApiKeyError extends Error {
  override readonly name = 'InvalidApiKeyError';
}

export interface ApiKeyVerifier {
  verify(key: string): Promise<ApiKeyIdentity>;
}

export interface ApiKeyVerifierOptions {
  /** identity-service, e.g. `http://identity-service:8080`. */
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  /**
   * How long a verified key is reused without asking again. Short: revoking a
   * key takes at most this long to bite here (and each service's permission
   * cache, 5 s, on top).
   */
  readonly ttlMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

/**
 * Asks identity-service (`POST /internal/v1/api-keys/verify`, service token)
 * which org a presented key acts for, and remembers a good answer briefly, by
 * a hash of the key so the cache never holds one. A refused key is never
 * remembered. Fails closed: identity-service unreachable is a 503, never a
 * pass.
 */
export function createApiKeyVerifier(options: ApiKeyVerifierOptions): ApiKeyVerifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 30_000;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const cache = new Map<string, { expires: number; identity: ApiKeyIdentity }>();
  const unavailable = () =>
    ProblemError.unavailable('Could not check the API key. Try again shortly.', {
      code: 'api_key_check_unavailable',
    });

  return {
    async verify(key) {
      const cacheKey = createHash('sha256').update(key).digest('hex');
      const hit = cache.get(cacheKey);
      if (hit !== undefined && hit.expires > now()) return hit.identity;

      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/internal/v1/api-keys/verify`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.internalServiceToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ key }),
        });
      } catch {
        throw unavailable();
      }
      if (response.status === 401 || response.status === 400) {
        throw new InvalidApiKeyError('the API key is not usable');
      }
      if (!response.ok) throw unavailable();
      const identity = (await response.json()) as ApiKeyIdentity;
      cache.set(cacheKey, { expires: now() + ttlMs, identity });
      if (cache.size > 10_000) cache.clear();
      return identity;
    },
  };
}
