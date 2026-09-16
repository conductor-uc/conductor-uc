/**
 * Calls trunk-service's internal single-trunk lookup
 * (`GET /internal/v1/tenants/:tenantId/trunks/:id`, S2-02) — how this service
 * validates a DID's `trunk_id` refers to a real trunk owned by the same
 * tenant, at create/update time.
 *
 * That endpoint also returns the trunk's decrypted register secret (it was
 * built for telephony-config's projection, S2-02) — this client deliberately
 * never surfaces the response body to its own caller, only whether the trunk
 * exists, so nothing here becomes a second place that secret could leak from.
 *
 * Gated by the same shared bearer token every other internal route in this
 * repo expects (07 §1's precedent, `org-client.ts`'s identical shape).
 */

export type TrunkLookup = (tenantId: string, trunkId: string) => Promise<boolean>;

export class TrunkClientError extends Error {
  override readonly name = 'TrunkClientError';
}

export interface TrunkClientOptions {
  /** e.g. `http://trunk-service:8080`. No trailing slash required. */
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export function createTrunkClient(options: TrunkClientOptions): { readonly exists: TrunkLookup } {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  return {
    /** True when `trunkId` exists in trunk-service under `tenantId`. */
    async exists(tenantId: string, trunkId: string): Promise<boolean> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/trunks/${encodeURIComponent(trunkId)}`,
          { headers: { authorization: `Bearer ${options.internalServiceToken}` } },
        );
      } catch (error) {
        throw new TrunkClientError(
          `Could not reach trunk-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (response.status === 404) return false;
      if (!response.ok) {
        throw new TrunkClientError(
          `trunk-service rejected the trunk lookup (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }
      return true;
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
