/**
 * Calls callflow-service's own internal IR route (S2-09;
 * `callflow-service/src/routes/internal.routes.ts`). This service never reads
 * callflow-service's database directly — same "each service owns its own
 * schema" story every other internal client in this codebase follows
 * (`pbx-config-client.ts`, `voicemail-client.ts`).
 *
 * `/fs/flow/...` (`routes/fs.routes.ts`) is a thin proxy over this client:
 * `flow_runner.lua` never calls callflow-service directly (CLAUDE.md rule 4 —
 * only telephony-config talks to FS nodes, and symmetrically, this service is
 * the only thing FS itself is configured to call). That indirection is also
 * what keeps the node from needing callflow-service's internal token.
 */

import type { FlowIR } from '@cuc/callflow-ir';

/** callflow-service's internal IR payload: the compiled IR plus its version identity. */
export interface PublishedFlowIr {
  readonly flowId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly ir: FlowIR;
}

export class CallflowClientError extends Error {
  override readonly name = 'CallflowClientError';
}

export interface CallflowClientOptions {
  /** e.g. http://callflow-service:8080. No trailing slash required. */
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface CallflowClient {
  /** The flow's currently published IR, or `undefined` when it has never published. */
  findPublishedIr(tenantId: string, flowId: string): Promise<PublishedFlowIr | undefined>;
}

export function createCallflowClient(options: CallflowClientOptions): CallflowClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${options.internalServiceToken}` };

  return {
    async findPublishedIr(tenantId, flowId) {
      const url =
        `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}` +
        `/flows/${encodeURIComponent(flowId)}/ir`;

      let response: Response;
      try {
        response = await fetchImpl(url, { method: 'GET', headers });
      } catch (error) {
        throw new CallflowClientError(
          `Could not reach callflow-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // 404 is callflow-service's own documented "no published version for
      // that flow" answer, which is a routable outcome (the dialplan plays a
      // miss), not a failure worth throwing over.
      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new CallflowClientError(
          `callflow-service rejected the request (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }
      return (await response.json()) as PublishedFlowIr;
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
