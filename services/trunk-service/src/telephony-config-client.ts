/**
 * Calls telephony-config's internal trunk-status lookup
 * (`GET /internal/v1/tenants/:tenantId/trunks/:id/status`, S2-02) — how
 * `:status` (06's trunk-service section) reads live registration state,
 * which only telephony-config can answer since it owns the OpenSIPs MI
 * connection (05 §1.1: no other service talks to OpenSIPs directly).
 *
 * Gated by the same shared bearer token every other internal route in this
 * repo expects (07 §1's precedent) — real service-to-service auth does not
 * exist yet.
 */

export type TrunkRegistrationStatus =
  'registered' | 'registering' | 'failed' | 'not_registered' | 'not_applicable';

export interface TrunkStatus {
  readonly status: TrunkRegistrationStatus;
}

export class TelephonyConfigClientError extends Error {
  override readonly name = 'TelephonyConfigClientError';
}

export interface TelephonyConfigClientOptions {
  /** e.g. http://telephony-config:8080. No trailing slash required. */
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface TelephonyConfigClient {
  /** Undefined when telephony-config has no record of that trunk (a 404). */
  findStatus(tenantId: string, trunkId: string): Promise<TrunkStatus | undefined>;
}

export function createTelephonyConfigClient(
  options: TelephonyConfigClientOptions,
): TelephonyConfigClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  return {
    async findStatus(tenantId: string, trunkId: string): Promise<TrunkStatus | undefined> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/trunks/${encodeURIComponent(trunkId)}/status`,
          { headers: { authorization: `Bearer ${options.internalServiceToken}` } },
        );
      } catch (error) {
        throw new TelephonyConfigClientError(
          `Could not reach telephony-config: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new TelephonyConfigClientError(
          `telephony-config rejected the status lookup (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      return (await response.json()) as TrunkStatus;
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
