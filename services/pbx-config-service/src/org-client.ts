/**
 * Calls org-service's internal tenant-domain lookup
 * (`GET /internal/v1/tenants/:id/domain`, S1-09) — how this service learns a
 * tenant's SIP realm when generating credentials for a new extension.
 *
 * Gated by the same shared bearer token org-service's own internal routes
 * expect (07 §1's precedent) — real service-to-service auth does not exist
 * yet.
 *
 * `TenantDomainLookup` is the interface repos depend on, not this module
 * directly, so a repo test can inject a fake instead of needing a live
 * org-service listening on a real port.
 */

export type TenantDomainLookup = (tenantId: string) => Promise<string | undefined>;

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
  readonly primaryDomain: TenantDomainLookup;
} {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  return {
    /** Undefined when the tenant has no primary domain yet (a 404 from org-service). */
    async primaryDomain(tenantId: string): Promise<string | undefined> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/domain`,
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
          `org-service rejected the domain lookup (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      const body = (await response.json()) as { fqdn: string };
      return body.fqdn;
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
