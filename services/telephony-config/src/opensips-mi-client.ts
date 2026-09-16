/**
 * Talks to OpenSIPs' Management Interface over `mi_http` (03 §2: "reloads
 * are triggered through MI ... after projection updates: `dr_reload`,
 * `address_reload`, `domain_reload`, `reg_reload`, `ds_reload`").
 *
 * `call()` fires a reload with no result worth reading: `domain_reload`
 * (S1-12: `domain` is db_mode=1, cached — a new row is invisible to
 * `is_uri_host_local()` until reloaded), and, since S2-02, `reg_reload`/
 * `address_reload` (`registrant`/`address` are cached the same way —
 * `uac_registrant` loads its table into a hash at startup, `permissions`
 * caches its `address` table). `usrloc` (db_mode=2) and `auth_db` query
 * MariaDB live and need no reload for a `subscriber` row to take effect —
 * confirmed while writing S1-11's config (see its own module comments).
 *
 * `query()` is for a command with a result worth reading — S2-02's trunk
 * status: `reg_list`, confirmed live against a real OpenSIPs 3.6.8 instance
 * (`opensips-cli -x mi which` lists it; `README.uac_registrant.gz` documents
 * its state codes and its `(aor, contact, registrar)` positional params).
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
  /**
   * An MI command that returns data (S2-02: `reg_list`, for live trunk
   * registration status) — `call()`'s `result` field, discarded there,
   * because every command it is used for (a reload) has none worth reading.
   */
  query<T = unknown>(method: string, params?: readonly unknown[]): Promise<T>;
}

interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

export function createOpenSipsMiClient(options: OpenSipsMiClientOptions): OpenSipsMiClient {
  const fetchImpl = options.fetchImpl ?? fetch;

  async function query<T>(method: string, params?: readonly unknown[]): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method,
          id: 1,
          ...(params === undefined ? {} : { params }),
        }),
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
    return body.result as T;
  }

  return {
    async call(method: string): Promise<void> {
      await query(method);
    },
    query,
  };
}
