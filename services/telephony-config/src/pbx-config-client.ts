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
