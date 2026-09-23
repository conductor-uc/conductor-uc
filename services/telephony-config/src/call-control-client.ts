/**
 * Calls call-control's `/internal/v1/affinity/...` (S2-12/S2-13; 04 §3.3).
 * The only write path this service has into the affinity lease system — a
 * plain read (`getOwner`) goes straight at the shared Redis state instead
 * (`fs.routes.ts`'s own doc comment on why), but *acquiring* a lease needs
 * call-control's own ESL connections to reload the chosen node, which only
 * that service holds (07 §1's "only call-control talks ESL" symmetry).
 *
 * Gated by the same shared bearer token every other internal client in this
 * codebase uses (07 §1's precedent).
 */

export type AffinityKind = 'queue' | 'park' | 'conf';

export interface AcquireAffinityResult {
  readonly nodeId: string;
  readonly acquired: boolean;
}

export class CallControlClientError extends Error {
  override readonly name = 'CallControlClientError';
}

export interface CallControlClientOptions {
  /** e.g. http://call-control:8080. No trailing slash required. */
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface CallControlClient {
  /**
   * Acquires (or reports the existing holder of) a resource's affinity
   * lease. `preferredNodeId` should be the node currently asking (this
   * request's own `nodeId` query param) — see `AffinityManager.acquire`'s
   * own doc comment in call-control for why "local" beats "least loaded"
   * when a call is already anchored on a specific node.
   */
  acquireAffinity(
    tenantId: string,
    kind: AffinityKind,
    resourceId: string,
    options: { readonly preferredNodeId?: string; readonly reloadCommands?: readonly string[] },
  ): Promise<AcquireAffinityResult>;
}

export function createCallControlClient(options: CallControlClientOptions): CallControlClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  return {
    async acquireAffinity(tenantId, kind, resourceId, acquireOptions) {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/affinity/${encodeURIComponent(tenantId)}/${encodeURIComponent(kind)}/${encodeURIComponent(resourceId)}/acquire`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${options.internalServiceToken}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              ...(acquireOptions.reloadCommands === undefined
                ? {}
                : { reloadCommands: acquireOptions.reloadCommands }),
              ...(acquireOptions.preferredNodeId === undefined
                ? {}
                : { preferredNodeId: acquireOptions.preferredNodeId }),
            }),
          },
        );
      } catch (error) {
        throw new CallControlClientError(
          `Could not reach call-control: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (!response.ok) {
        throw new CallControlClientError(
          `call-control rejected the affinity acquire (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      return (await response.json()) as AcquireAffinityResult;
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
