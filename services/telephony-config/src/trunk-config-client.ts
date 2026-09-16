/**
 * Calls trunk-service's internal trunk and outbound-route lookups (`GET
 * /internal/v1/tenants/:tenantId/trunks/:id` and `GET /internal/v1/trunks`,
 * S2-02; the same shape for `outbound-routes`, S2-04) — how this service
 * learns a trunk's full config (including the plaintext register secret) or
 * an outbound route's current definition to project into OpenSIPs, and how
 * reconciliation lists everything that should exist. `trunk.trunk.*`/
 * `trunk.outbound_route.*` events carry only an id (06: events stay thin),
 * so every `created`/`updated` handler fetches current state here rather
 * than trusting the payload.
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
  /** S2-04's caller-ID precedence, third tier (G-22). Null means no trunk-level fallback set. */
  readonly callerIdPolicy: { readonly name: string | null; readonly number: string | null } | null;
}

export interface OutboundRouteConfig {
  readonly id: string;
  readonly tenantId: string;
  readonly priority: number;
  readonly pattern: string;
  readonly trunkIds: readonly string[];
  readonly strip: number;
  readonly prepend: string | null;
}

/** A tenant's single emergency route (S2-06; G-1) — no `priority`/`strip`/`prepend`, unlike `OutboundRouteConfig` (`emergency-route.repo.ts`'s own doc comment on why). */
export interface EmergencyRouteConfig {
  readonly id: string;
  readonly tenantId: string;
  readonly trunkId: string;
  readonly numbers: readonly string[];
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
  /** Undefined when the outbound route does not exist in that tenant (a 404). */
  findOutboundRoute(
    tenantId: string,
    outboundRouteId: string,
  ): Promise<OutboundRouteConfig | undefined>;
  /** Every outbound route, across every tenant — what the reconciliation pass diffs against. */
  listAllOutboundRoutes(): Promise<OutboundRouteConfig[]>;
  /** Undefined when the tenant has no emergency route configured (a 404). */
  findEmergencyRoute(tenantId: string): Promise<EmergencyRouteConfig | undefined>;
  /** Every tenant's emergency route — what the reconciliation pass diffs against. */
  listAllEmergencyRoutes(): Promise<EmergencyRouteConfig[]>;
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

    async findOutboundRoute(
      tenantId: string,
      outboundRouteId: string,
    ): Promise<OutboundRouteConfig | undefined> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/outbound-routes/${encodeURIComponent(outboundRouteId)}`,
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
          `trunk-service rejected the outbound-route lookup (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      return (await response.json()) as OutboundRouteConfig;
    },

    async listAllOutboundRoutes(): Promise<OutboundRouteConfig[]> {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/internal/v1/outbound-routes`, { headers });
      } catch (error) {
        throw new TrunkConfigClientError(
          `Could not reach trunk-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (!response.ok) {
        throw new TrunkConfigClientError(
          `trunk-service rejected the outbound-route list (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      const body = (await response.json()) as { rows: OutboundRouteConfig[] };
      return body.rows;
    },

    async findEmergencyRoute(tenantId: string): Promise<EmergencyRouteConfig | undefined> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/emergency-route`,
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
          `trunk-service rejected the emergency-route lookup (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      return (await response.json()) as EmergencyRouteConfig;
    },

    async listAllEmergencyRoutes(): Promise<EmergencyRouteConfig[]> {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/internal/v1/emergency-routes`, { headers });
      } catch (error) {
        throw new TrunkConfigClientError(
          `Could not reach trunk-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (!response.ok) {
        throw new TrunkConfigClientError(
          `trunk-service rejected the emergency-route list (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      const body = (await response.json()) as { rows: EmergencyRouteConfig[] };
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
