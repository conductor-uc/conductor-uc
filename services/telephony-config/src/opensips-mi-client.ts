/**
 * Triggers OpenSIPs' Management Interface over `mi_http` (03 §2: "reloads
 * are triggered through MI ... after projection updates: `dr_reload`,
 * `address_reload`, `domain_reload`, `reg_reload`, `ds_reload`").
 *
 * Only `domain_reload` is ever called by this service (S1-12: `domain` is
 * db_mode=1, cached — a new row is invisible to `is_uri_host_local()` until
 * reloaded). `usrloc` (db_mode=2) and `auth_db` query MariaDB live and need
 * no reload for a `subscriber` row to take effect — confirmed while writing
 * S1-11's config (see its own module comments).
 *
 * Request/response shape is JSON-RPC 2.0
 * (docs.opensips.org/docs/modules/3.6.x/mi_http.html) — the same transport
 * `opensips-cli -o communication_type=http` used for real verification in
 * S1-11.
 */

export class OpenSipsMiClientError extends Error {
  override readonly name = 'OpenSipsMiClientError';
}

export interface OpenSipsMiClientOptions {
  /** e.g. http://opensips:8888/mi. */
  readonly url: string;
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface OpenSipsMiClient {
  /** Fire-and-confirm one MI command with no parameters. */
  call(method: string): Promise<void>;
}

interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

export function createOpenSipsMiClient(options: OpenSipsMiClientOptions): OpenSipsMiClient {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async call(method: string): Promise<void> {
      let response: Response;
      try {
        response = await fetchImpl(options.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method, id: 1 }),
        });
      } catch (error) {
        throw new OpenSipsMiClientError(
          `Could not reach OpenSIPs MI (${method}): ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }

      if (!response.ok) {
        throw new OpenSipsMiClientError(
          `OpenSIPs MI rejected '${method}' (${String(response.status)}): ${await response.text()}`,
        );
      }

      const body = (await response.json()) as JsonRpcResponse;
      if (body.error !== undefined) {
        throw new OpenSipsMiClientError(
          `OpenSIPs MI '${method}' failed (${String(body.error.code)}): ${body.error.message}`,
        );
      }
    },
  };
}
