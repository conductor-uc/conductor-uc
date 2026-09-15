/**
 * Calls org-service's internal tenant-reseller lookup
 * (`GET /internal/v1/tenants/:id/reseller`, S2-01) — how this service learns
 * which reseller owns a tenant, denormalized onto `trunks.reseller_id`
 * (05 §3.4) so a reseller-scoped trunk list never needs a cross-schema join
 * (05 §1.1). Same shape as pbx-config-service's `org-client.ts` (S1-09).
 *
 * Gated by the same shared bearer token org-service's own internal routes
 * expect (07 §1's precedent) — real service-to-service auth does not exist
 * yet.
 *
 * `TenantResellerLookup` is the interface repos depend on, not this module
 * directly, so a repo test can inject a fake instead of needing a live
 * org-service listening on a real port.
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
