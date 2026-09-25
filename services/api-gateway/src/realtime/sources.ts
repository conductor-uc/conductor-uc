import { liveCallFromSnapshot, type LiveCall } from './calls.js';

/** Where an org sits in the tree (org-service's `GET /internal/v1/orgs/:id/lineage`). */
export interface OrgLineage {
  readonly type: 'master' | 'reseller' | 'tenant';
  readonly resellerId: string | null;
}

/** Undefined when there is no such org. Throws when org-service cannot be asked. */
export type LineageLookup = (orgId: string) => Promise<OrgLineage | undefined>;

/** The tenant's live calls now. Throws when call-control cannot be asked. */
export type LiveCallsSource = (tenantId: string) => Promise<LiveCall[]>;

export class SourceUnavailableError extends Error {
  override readonly name = 'SourceUnavailableError';
}

interface InternalClientOptions {
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

async function internalGet(
  options: InternalClientOptions,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${options.baseUrl.replace(/\/+$/, '')}${path}`, {
      headers: { authorization: `Bearer ${options.internalServiceToken}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
  } catch (error) {
    throw new SourceUnavailableError(error instanceof Error ? error.message : String(error));
  }
  if (response.status === 404) return { status: 404, body: undefined };
  if (!response.ok) throw new SourceUnavailableError(`HTTP ${String(response.status)}`);
  return { status: response.status, body: await response.json() };
}

/**
 * Asks org-service where an org sits. Orgs never move (org-service's own
 * comment on the route), so an answer is kept for as long as the process runs;
 * "no such org" is asked again after a minute, since the org may be created
 * meanwhile. The cache is bounded.
 */
export function createLineageLookup(
  options: InternalClientOptions & { now?: () => number },
): LineageLookup {
  const now = options.now ?? Date.now;
  const known = new Map<string, OrgLineage>();
  const missing = new Map<string, number>();

  return async (orgId) => {
    const hit = known.get(orgId);
    if (hit !== undefined) return hit;
    const missUntil = missing.get(orgId);
    if (missUntil !== undefined && missUntil > now()) return undefined;

    const { status, body } = await internalGet(
      options,
      `/internal/v1/orgs/${encodeURIComponent(orgId)}/lineage`,
    );
    if (status === 404) {
      if (missing.size > 10_000) missing.clear();
      missing.set(orgId, now() + 60_000);
      return undefined;
    }
    const record = body as { type?: unknown; resellerId?: unknown };
    const type = record.type;
    if (type !== 'master' && type !== 'reseller' && type !== 'tenant') {
      throw new SourceUnavailableError('Unexpected lineage answer.');
    }
    const lineage: OrgLineage = {
      type,
      resellerId: typeof record.resellerId === 'string' ? record.resellerId : null,
    };
    if (known.size > 10_000) known.clear();
    known.set(orgId, lineage);
    return lineage;
  };
}

/** Asks call-control for the tenant's live calls (`GET /internal/v1/tenants/:t/calls`). */
export function createLiveCallsSource(options: InternalClientOptions): LiveCallsSource {
  return async (tenantId) => {
    const { body } = await internalGet(
      options,
      `/internal/v1/tenants/${encodeURIComponent(tenantId)}/calls`,
    );
    const calls = (body as { calls?: unknown } | undefined)?.calls;
    if (!Array.isArray(calls)) throw new SourceUnavailableError('Unexpected live calls answer.');
    return calls.flatMap((entry) => {
      const call = liveCallFromSnapshot(entry);
      return call === undefined ? [] : [call];
    });
  };
}
