/**
 * Calls pbx-config-service's own internal media-asset routes (S2-07;
 * `internal.routes.ts`'s own doc comments on each). This service never
 * reads pbx-config-service's database directly — that is the whole point
 * of splitting the transcode step into its own service (S2-07's own scope
 * decision).
 *
 * Gated by the same shared bearer token every other internal route in this
 * repo expects (07 §1's precedent) — real service-to-service auth does not
 * exist yet.
 */

export interface MediaAssetForTranscode {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly contentType: string;
  readonly objectKey: string;
}

export interface CompleteMediaAssetInput {
  readonly durationMs: number;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly variant8kKey: string;
  readonly variant16kKey: string;
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
  /** Undefined when pbx-config-service has no record of that asset (a 404). */
  findMediaAsset(tenantId: string, id: string): Promise<MediaAssetForTranscode | undefined>;
  completeMediaAsset(tenantId: string, id: string, input: CompleteMediaAssetInput): Promise<void>;
  failMediaAsset(tenantId: string, id: string, errorMessage: string): Promise<void>;
}

export function createPbxConfigClient(options: PbxConfigClientOptions): PbxConfigClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${options.internalServiceToken}` };

  function assetUrl(tenantId: string, id: string): string {
    return `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/media-assets/${encodeURIComponent(id)}`;
  }

  async function call(
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
  ): Promise<Response | undefined> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new PbxConfigClientError(
        `Could not reach pbx-config-service: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new PbxConfigClientError(
        `pbx-config-service rejected the request (${String(response.status)}): ` +
          (await responseDetail(response)),
      );
    }
    return response;
  }

  return {
    async findMediaAsset(tenantId, id) {
      const response = await call('GET', assetUrl(tenantId, id));
      if (response === undefined) return undefined;
      return (await response.json()) as MediaAssetForTranscode;
    },
    async completeMediaAsset(tenantId, id, input) {
      await call('POST', `${assetUrl(tenantId, id)}/complete`, input);
    },
    async failMediaAsset(tenantId, id, errorMessage) {
      await call('POST', `${assetUrl(tenantId, id)}/fail`, { errorMessage });
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
