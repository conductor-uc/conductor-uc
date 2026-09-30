/**
 * Reads trunk-service's internal API (S2-06, G-1): the addresses a tenant's emergency route says
 * to email when someone dials an emergency number. Never trunk-service's database directly: each
 * service owns its schema (05 §1.1).
 */

export class TrunkClientError extends Error {
  override readonly name = 'TrunkClientError';
}

export interface TrunkClientOptions {
  /** e.g. http://trunk-service:8080. No trailing slash required. */
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface TrunkClient {
  /** Who is emailed on an emergency call; none when the tenant has no emergency route. */
  emergencyNotifyEmails(tenantId: string): Promise<string[]>;
}

export function createTrunkClient(options: TrunkClientOptions): TrunkClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  return {
    async emergencyNotifyEmails(tenantId) {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/emergency-route`,
          {
            headers: { authorization: `Bearer ${options.internalServiceToken}` },
            signal: AbortSignal.timeout(10_000),
          },
        );
      } catch (error) {
        throw new TrunkClientError(
          `Could not reach trunk-service (${error instanceof Error ? error.name : 'error'}).`,
        );
      }
      if (response.status === 404) return [];
      if (!response.ok) {
        throw new TrunkClientError(
          `trunk-service rejected the emergency route lookup (${String(response.status)}).`,
        );
      }
      const route = (await response.json()) as { notifyEmails?: string[] };
      return route.notifyEmails ?? [];
    },
  };
}
