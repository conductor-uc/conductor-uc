import type { Grant } from '@cuc/authz';

/**
 * What the signed-in user may do, as identity-service knows it: the roles they hold with
 * each role's permissions (built-in and the org's custom ones), and every grant naming
 * them or one of those roles. Enough for `@cuc/authz`'s `allowed()`.
 */
export interface ActorAccess {
  readonly roles: readonly { readonly id: string; readonly permissions: readonly string[] }[];
  readonly grants: readonly Grant[];
}

export class AccessUnavailableError extends Error {
  override readonly name = 'AccessUnavailableError';
}

export interface AccessClient {
  resolve(input: { readonly orgId: string; readonly actorId: string }): Promise<ActorAccess>;
}

export interface HttpAccessClientOptions {
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  /** How long one user's answer is reused. */
  readonly ttlMs: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

/**
 * Asks identity-service (`GET /internal/v1/orgs/:orgId/users/:userId/access`). The answer is
 * cached briefly per user: a revoked grant keeps working for at most `ttlMs`. When
 * identity-service cannot be reached the request is refused (fail closed), because unlike
 * the dialplan's recording decision there is no harmless default for "may this user hear
 * a call".
 */
export function createHttpAccessClient(options: HttpAccessClientOptions): AccessClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const cache = new Map<string, { expiresAt: number; access: ActorAccess }>();

  return {
    async resolve({ orgId, actorId }) {
      const key = `${orgId}/${actorId}`;
      const hit = cache.get(key);
      if (hit !== undefined && hit.expiresAt > now()) return hit.access;

      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/orgs/${encodeURIComponent(orgId)}/users/${encodeURIComponent(actorId)}/access`,
          { headers: { authorization: `Bearer ${options.internalServiceToken}` } },
        );
      } catch {
        throw new AccessUnavailableError('identity-service could not be reached.');
      }
      if (response.status === 404) {
        // A user with no record has no roles and no grants.
        return { roles: [], grants: [] };
      }
      if (!response.ok) {
        throw new AccessUnavailableError(
          `identity-service answered ${String(response.status)} for a permission lookup.`,
        );
      }

      const access = (await response.json()) as ActorAccess;
      cache.set(key, { expiresAt: now() + options.ttlMs, access });
      return access;
    },
  };
}
