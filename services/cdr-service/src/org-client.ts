/**
 * Calls org-service's internal tenant-reseller lookup
 * (`GET /internal/v1/tenants/:id/reseller`) — how this service denormalizes
 * `cdrs.reseller_id` at ingest time (C-1/D-013), the same shape
 * trunk-service's own `org-client.ts` already establishes for
 * `trunks.reseller_id` (05 §3.4).
 *
 * Gated by the same shared bearer token org-service's own internal routes
 * expect (07 §1's precedent) — real service-to-service auth does not exist
 * yet.
 */

export type TenantResellerLookup = (tenantId: string) => Promise<string | undefined>;

export class OrgClientError extends Error {
  override readonly name = 'OrgClientError';
}

export interface OrgClientOptions {
  /** e.g. `http://org-service:8080`. No trailing slash required. */
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export function createOrgClient(options: OrgClientOptions): {
  readonly resellerForTenant: TenantResellerLookup;
} {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  return {
    /** Undefined when the tenant does not exist, or has no owning reseller (a 404 from org-service). */
    async resellerForTenant(tenantId: string): Promise<string | undefined> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/reseller`,
          { headers: { authorization: `Bearer ${options.internalServiceToken}` } },
        );
      } catch (error) {
        throw new OrgClientError(
          `Could not reach org-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new OrgClientError(
          `org-service rejected the reseller lookup (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      const body = (await response.json()) as { resellerId: string };
      return body.resellerId;
    },
  };
}

async function responseDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { title?: string; detail?: string };
    return body.detail ?? body.title ?? response.statusText;
  } catch {
    return response.statusText;
  }
}
