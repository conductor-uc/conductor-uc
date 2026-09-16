/**
 * Calls pbx-config-service's internal digest-credential lookup
 * (`GET /internal/v1/tenants/:tenantId/extensions/:id`, S1-12) — how this
 * service learns the username/HA1/realm to project into OpenSIPs'
 * `subscriber` table. `pbx.extension.*` events carry only an id (06: events
 * stay thin), so every `created`/`updated` handler fetches current state
 * here rather than trusting anything in the event payload itself.
 *
 * Gated by the same shared bearer token pbx-config-service's own internal
 * routes expect (07 §1's precedent, `org-client.ts`'s identical shape from
 * S1-09) — real service-to-service auth does not exist yet.
 */

export interface DigestCredential {
  readonly extensionId: string;
  /** The extension's current dialable number — S1-13's `/fs/dialplan` matches on this. */
  readonly number: string;
  readonly username: string;
  readonly ha1: string;
  readonly ha1b: string;
  readonly realm: string;
  /** S2-04's caller-ID precedence, first tier: the extension's own override, if set. */
  readonly callerIdName: string | null;
  readonly callerIdNumber: string | null;
  /** S2-06 (G-1) — an `emergency_locations` id in this same tenant, required at extension-creation time. */
  readonly emergencyLocationId: string;
}

/**
 * A dispatchable civic address (S2-06; G-1) — what `findEmergencyLocation`
 * resolves an extension's `emergencyLocationId` to, live, at the moment an
 * emergency call actually needs one (never cached — see this file's own
 * "thin event, re-fetch current state" framing above, the same reasoning).
 */
export interface EmergencyLocationConfig {
  readonly id: string;
  readonly label: string;
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  readonly country: string;
}

/**
 * A media asset's current state (S2-07) — what `/fs/media/:id`'s resolver
 * (`routes/fs.routes.ts`) fetches live, at the moment FS's own `http_cache`
 * module actually asks for it (never mirrored — the same "must reflect the
 * very latest write" reasoning `findEmergencyLocation` above already
 * documents, and this is an even colder path: fetched once per node until
 * that node's own local disk cache expires or the node restarts).
 */
export interface MediaAssetConfig {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  /** Null until `status` is `'ready'`. */
  readonly variant8kKey: string | null;
  readonly variant16kKey: string | null;
}

/**
 * A DID's current state (S2-03) — what `pbx.did.*`'s "thin event, re-fetch
 * current state" projection (`projection.ts`'s `projectDid`) fetches to keep
 * telephony-config's own local `dids` mirror current.
 */
export interface DidConfig {
  readonly id: string;
  readonly e164: string;
  readonly trunkId: string;
  readonly destinationType: string;
  readonly destinationId: string;
}

export class PbxConfigClientError extends Error {
  override readonly name = 'PbxConfigClientError';
}

export interface PbxConfigClientOptions {
  /** e.g. http://pbx-config-service:8080. No trailing slash required. */
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface PbxConfigClient {
  /** Undefined when the extension does not exist in that tenant (a 404). */
  findCredential(tenantId: string, extensionId: string): Promise<DigestCredential | undefined>;
  /** Undefined when the DID does not exist in that tenant (a 404). */
  findDid(tenantId: string, didId: string): Promise<DidConfig | undefined>;
  /** Undefined when the location does not exist in that tenant (a 404). */
  findEmergencyLocation(
    tenantId: string,
    locationId: string,
  ): Promise<EmergencyLocationConfig | undefined>;
  /** Undefined when the asset does not exist in that tenant (a 404). */
  findMediaAsset(tenantId: string, id: string): Promise<MediaAssetConfig | undefined>;
}

export function createPbxConfigClient(options: PbxConfigClientOptions): PbxConfigClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  return {
    async findCredential(
      tenantId: string,
      extensionId: string,
    ): Promise<DigestCredential | undefined> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/extensions/${encodeURIComponent(extensionId)}`,
          { headers: { authorization: `Bearer ${options.internalServiceToken}` } },
        );
      } catch (error) {
        throw new PbxConfigClientError(
          `Could not reach pbx-config-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new PbxConfigClientError(
          `pbx-config-service rejected the credential lookup (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      return (await response.json()) as DigestCredential;
    },

    async findDid(tenantId: string, didId: string): Promise<DidConfig | undefined> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/dids/${encodeURIComponent(didId)}`,
          { headers: { authorization: `Bearer ${options.internalServiceToken}` } },
        );
      } catch (error) {
        throw new PbxConfigClientError(
          `Could not reach pbx-config-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new PbxConfigClientError(
          `pbx-config-service rejected the DID lookup (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      return (await response.json()) as DidConfig;
    },

    async findEmergencyLocation(
      tenantId: string,
      locationId: string,
    ): Promise<EmergencyLocationConfig | undefined> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/emergency-locations/${encodeURIComponent(locationId)}`,
          { headers: { authorization: `Bearer ${options.internalServiceToken}` } },
        );
      } catch (error) {
        throw new PbxConfigClientError(
          `Could not reach pbx-config-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new PbxConfigClientError(
          `pbx-config-service rejected the emergency location lookup (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      return (await response.json()) as EmergencyLocationConfig;
    },

    async findMediaAsset(tenantId: string, id: string): Promise<MediaAssetConfig | undefined> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/media-assets/${encodeURIComponent(id)}`,
          { headers: { authorization: `Bearer ${options.internalServiceToken}` } },
        );
      } catch (error) {
        throw new PbxConfigClientError(
          `Could not reach pbx-config-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new PbxConfigClientError(
          `pbx-config-service rejected the media asset lookup (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      return (await response.json()) as MediaAssetConfig;
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
