/**
 * Calls identity-service's internal routes (G-100): today only the list of an
 * org's administrators, so the notice that someone's two-step verification was
 * reset can go to the org's other admins without the event carrying their
 * addresses. Gated by the shared bearer token identity-service's internal
 * routes expect (07 §1's precedent). Nothing here logs an address.
 */
export class IdentityClientError extends Error {
  override readonly name = 'IdentityClientError';
}

export interface OrgAdmin {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
}

export interface IdentityClientOptions {
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface IdentityClient {
  /** The org's active administrators. Throws when identity-service cannot be reached. */
  admins(orgId: string): Promise<OrgAdmin[]>;
}

export function createIdentityClient(options: IdentityClientOptions): IdentityClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  return {
    async admins(orgId) {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/orgs/${encodeURIComponent(orgId)}/admins`,
          {
            headers: { authorization: `Bearer ${options.internalServiceToken}` },
            signal: AbortSignal.timeout(10_000),
          },
        );
      } catch (error) {
        throw new IdentityClientError(
          `Could not reach identity-service (${error instanceof Error ? error.name : 'error'}).`,
        );
      }
      if (!response.ok) {
        throw new IdentityClientError(
          `identity-service rejected the admins lookup (${String(response.status)}).`,
        );
      }
      return ((await response.json()) as { rows: OrgAdmin[] }).rows;
    },
  };
}
