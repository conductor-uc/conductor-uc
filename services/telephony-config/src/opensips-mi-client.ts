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
  /**
   * Every edge's `mi_http` endpoint, e.g. `http://opensips:8888/mi` (S4-06: one per edge of the
   * pair; a single edge has one).
   */
  readonly urls: readonly string[];
  /** S4-06: the sharing tag whose active edge answers queries. */
  readonly activeTag?: string;
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** How long the active edge is remembered. */
  readonly activeCacheMs?: number;
}

export interface OpenSipsMiClient {
  /**
   * Fire-and-confirm one MI command with no parameters, on every edge (S4-06: a reload must
   * reach both, since each keeps its own copy of the tables). Succeeds when at least one edge
   * took it: an edge that is down loads the tables afresh when it starts. Fails when none did.
   */
  call(method: string): Promise<void>;
  /**
   * An MI command that returns data (S2-02: `reg_list`, for live trunk
   * registration status) — `call()`'s `result` field, discarded there,
   * because every command it is used for (a reload) has none worth reading.
   * S4-06: sent to the active edge (the one holding the floating address), which is the one
   * registering trunks, probing media nodes and acting on dialogs; the other edge's answers to
   * those would be stale or idle.
   */
  query<T = unknown>(method: string, params?: MiParams): Promise<T>;
}

/**
 * Positional, or named where a command is ambiguous without names (S4-12: `ds_list` with `full`,
 * `get_statistics` with `statistics`; OpenSIPs answers "Ambiguous call, use named parameters").
 */
export type MiParams = readonly unknown[] | Readonly<Record<string, unknown>>;

interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

/** The default sharing tag of the edge pair (`opensips.cfg.template`). */
export const EDGE_SHARING_TAG = 'vip/1';

/**
 * Whether `clusterer_list_shtags`'s answer says `tag` (`name/cluster`) is active on the edge that
 * answered. Read loosely: a list of `{Tag, Cluster, State}`-like entries, alone or under a key.
 */
export function isTagActive(result: unknown, tag: string): boolean {
  const [name, cluster] = tag.split('/');
  const entries: unknown[] = Array.isArray(result)
    ? result
    : typeof result === 'object' && result !== null
      ? Object.values(result as Record<string, unknown>).flatMap((value: unknown): unknown[] =>
          Array.isArray(value) ? (value as unknown[]) : [value],
        )
      : [];
  return entries.some((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const fields = Object.fromEntries(
      Object.entries(entry).map(([key, value]) => [key.toLowerCase(), String(value)]),
    );
    const entryName = fields['tag'] ?? fields['name'];
    const entryCluster = fields['cluster'] ?? fields['cluster_id'];
    return (
      (entryName === tag ||
        (entryName === name && (cluster === undefined || entryCluster === cluster))) &&
      /^active$/i.test(fields['state'] ?? '')
    );
  });
}

export function createOpenSipsMiClient(options: OpenSipsMiClientOptions): OpenSipsMiClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const urls = options.urls;
  if (urls.length === 0) throw new Error('OpenSIPs MI: no edge address given');
  const activeTag = options.activeTag ?? EDGE_SHARING_TAG;
  const activeCacheMs = options.activeCacheMs ?? 2_000;
  let active: { url: string; until: number } | undefined;

  async function queryAt<T>(url: string, method: string, params?: MiParams): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
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

  /** The active edge's endpoint; with one edge, that one. The first reachable when none says so. */
  async function activeUrl(): Promise<string> {
    const only = urls[0];
    if (urls.length === 1 && only !== undefined) return only;
    if (active !== undefined && active.until > Date.now()) return active.url;
    let reachable: string | undefined;
    for (const url of urls) {
      try {
        const tags = await queryAt(url, 'clusterer_list_shtags');
        reachable ??= url;
        if (isTagActive(tags, activeTag)) {
          active = { url, until: Date.now() + activeCacheMs };
          return url;
        }
      } catch {
        // That edge is down; try the next.
      }
    }
    if (reachable === undefined) {
      throw new OpenSipsMiClientError('Could not reach any OpenSIPs MI endpoint');
    }
    return reachable;
  }

  async function query<T>(method: string, params?: MiParams): Promise<T> {
    const url = await activeUrl();
    try {
      return await queryAt<T>(url, method, params);
    } catch (error) {
      // The active edge may just have failed over: ask again once.
      if (urls.length === 1 || active?.url !== url) throw error;
      active = undefined;
      const next = await activeUrl();
      if (next === url) throw error;
      return queryAt<T>(next, method, params);
    }
  }

  return {
    async call(method: string): Promise<void> {
      const results = await Promise.allSettled(urls.map((url) => queryAt(url, method)));
      const failed = results.filter((result) => result.status === 'rejected');
      if (failed.length === results.length) {
        throw (failed[0] as PromiseRejectedResult).reason;
      }
    },
    query,
  };
}
