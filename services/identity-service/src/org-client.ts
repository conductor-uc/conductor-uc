/**
 * Calls org-service's internal sign-in scope lookup
 * (`GET /internal/v1/hosts/:host/sign-in-scope`): which org's users sign in at
 * a console hostname (G-56). Gated by the shared bearer token org-service's
 * internal routes expect (07 §1's precedent).
 */
export class OrgClientError extends Error {
  override readonly name = 'OrgClientError';
}

export interface SignInScope {
  readonly orgId: string;
  readonly type: 'master' | 'reseller';
}

export interface OrgClient {
  /** Undefined for a hostname no org owns. Throws when org-service cannot be reached. */
  signInScope(host: string): Promise<SignInScope | undefined>;
}

export interface OrgClientOptions {
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export function createOrgClient(options: OrgClientOptions): OrgClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  return {
    async signInScope(host) {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/hosts/${encodeURIComponent(host)}/sign-in-scope`,
          {
            headers: { authorization: `Bearer ${options.internalServiceToken}` },
            signal: AbortSignal.timeout(5_000),
          },
        );
      } catch (error) {
        throw new OrgClientError(
          `Could not reach org-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new OrgClientError(
          `org-service rejected the sign-in scope lookup (${String(response.status)}).`,
        );
      }
      const body = (await response.json()) as SignInScope;
      return { orgId: body.orgId, type: body.type };
    },
  };
}
