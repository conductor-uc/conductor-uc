/**
 * Calls trunk-service's internal trunk lookups (`GET /internal/v1/tenants/
 * :tenantId/trunks/:id` and `GET /internal/v1/trunks`, S2-02) — how this
 * service learns a trunk's full config (including the plaintext register
 * secret) to project into OpenSIPs, and how reconciliation lists every
 * trunk that should exist. `trunk.trunk.*` events carry only `{trunkId,
 * name, authMode}` (06: events stay thin), so every `created`/`updated`
 * handler fetches current state here rather than trusting the payload.
 *
 * Gated by the same shared bearer token every other internal client in this
 * repo expects (07 §1's precedent, `pbx-config-client.ts`'s identical shape)
 * — real service-to-service auth does not exist yet.
 */

export interface TrunkConfig {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly authMode: string;
  readonly host: string;
  readonly port: number;
  readonly transport: string;
  readonly username: string | null;
  readonly secret: string | null;
  readonly fromDomain: string | null;
  readonly status: string;
  readonly ips: readonly string[];
}

export class TrunkConfigClientError extends Error {
  override readonly name = 'TrunkConfigClientError';
}

export interface TrunkConfigClientOptions {
  /** e.g. http://trunk-service:8080. No trailing slash required. */
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface TrunkConfigClient {
  /** Undefined when the trunk does not exist in that tenant (a 404). */
  findTrunk(tenantId: string, trunkId: string): Promise<TrunkConfig | undefined>;
  /** Every trunk, across every tenant — what the reconciliation pass diffs against. */
  listAllTrunks(): Promise<TrunkConfig[]>;
}

export function createTrunkConfigClient(options: TrunkConfigClientOptions): TrunkConfigClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${options.internalServiceToken}` };

  return {
    async findTrunk(tenantId: string, trunkId: string): Promise<TrunkConfig | undefined> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/trunks/${encodeURIComponent(trunkId)}`,
          { headers },
        );
      } catch (error) {
        throw new TrunkConfigClientError(
          `Could not reach trunk-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new TrunkConfigClientError(
          `trunk-service rejected the trunk lookup (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      return (await response.json()) as TrunkConfig;
    },

    async listAllTrunks(): Promise<TrunkConfig[]> {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/internal/v1/trunks`, { headers });
      } catch (error) {
        throw new TrunkConfigClientError(
          `Could not reach trunk-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (!response.ok) {
        throw new TrunkConfigClientError(
          `trunk-service rejected the trunk list (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      const body = (await response.json()) as { rows: TrunkConfig[] };
      return body.rows;
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
