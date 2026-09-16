/**
 * Calls org-service's internal tenant-country lookup
 * (`GET /internal/v1/tenants/:id/country`, S2-04) — how this service learns
 * a tenant's country to normalize an outbound-dialed number to E.164
 * (`domain/e164.ts`). Fetched once, at `org.tenant.created` time
 * (`consumers/org.consumer.ts`), and mirrored on the local `tenants` row —
 * not re-fetched on every call, since nothing in scope re-triggers this
 * lookup if a tenant's country changes later (docs/decisions.md gap).
 *
 * Gated by the same shared bearer token org-service's own internal routes
 * expect (07 §1's precedent, `pbx-config-client.ts`'s identical shape).
 */

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

export interface OrgClient {
  /** Undefined when the tenant does not exist (a 404). */
  findCountry(tenantId: string): Promise<string | undefined>;
}

export function createOrgClient(options: OrgClientOptions): OrgClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  return {
    async findCountry(tenantId: string): Promise<string | undefined> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/country`,
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
          `org-service rejected the country lookup (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      const body = (await response.json()) as { country: string };
      return body.country;
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
