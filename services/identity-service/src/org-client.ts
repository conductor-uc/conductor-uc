/**
 * Calls org-service's internal sign-in scope lookup
 * (`GET /internal/v1/hosts/:host/sign-in-scope`): which org's users sign in at
 * a console hostname (G-56). Gated by the shared bearer token org-service's
 * internal routes expect (07 §1's precedent).
 */
export class OrgClientError extends Error {
  override readonly name = 'OrgClientError';
}

export interface SignInScope {
  readonly orgId: string;
  readonly type: 'master' | 'reseller';
}

/** Where an org sits in the tree (`GET /internal/v1/orgs/:id/lineage`). */
export interface OrgLineage {
  readonly orgId: string;
  readonly type: 'master' | 'reseller' | 'tenant';
  readonly parentId: string | null;
  /** The reseller the org is or belongs to; null for the master. */
  readonly resellerId: string | null;
}

export interface OrgClient {
  /** Undefined for a hostname no org owns. Throws when org-service cannot be reached. */
  signInScope(host: string): Promise<SignInScope | undefined>;
  /**
   * Where [orgId] sits in the tree, or undefined for no such org. Orgs never
   * move, so a found answer is remembered; a missing one is not, because the
   * org may be created a moment later. Throws when org-service cannot be
   * reached.
   */
  lineage(orgId: string): Promise<OrgLineage | undefined>;
}

const LINEAGE_CACHE_MAX = 5_000;

export interface OrgClientOptions {
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export function createOrgClient(options: OrgClientOptions): OrgClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const lineages = new Map<string, OrgLineage>();
  return {
    async lineage(orgId) {
      const known = lineages.get(orgId);
      if (known !== undefined) return known;
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/orgs/${encodeURIComponent(orgId)}/lineage`,
          {
            headers: { authorization: `Bearer ${options.internalServiceToken}` },
            signal: AbortSignal.timeout(5_000),
          },
        );
      } catch (error) {
        throw new OrgClientError(
          `Could not reach org-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new OrgClientError(
          `org-service rejected the lineage lookup (${String(response.status)}).`,
        );
      }
      const body = (await response.json()) as OrgLineage;
      const found: OrgLineage = {
        orgId: body.orgId,
        type: body.type,
        parentId: body.parentId,
        resellerId: body.resellerId,
      };
      if (lineages.size >= LINEAGE_CACHE_MAX) {
        const oldest = lineages.keys().next();
        if (oldest.done !== true) lineages.delete(oldest.value);
      }
      lineages.set(orgId, found);
      return found;
    },

    async signInScope(host) {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/hosts/${encodeURIComponent(host)}/sign-in-scope`,
          {
            headers: { authorization: `Bearer ${options.internalServiceToken}` },
            signal: AbortSignal.timeout(5_000),
          },
        );
      } catch (error) {
        throw new OrgClientError(
          `Could not reach org-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new OrgClientError(
          `org-service rejected the sign-in scope lookup (${String(response.status)}).`,
        );
      }
      const body = (await response.json()) as SignInScope;
      return { orgId: body.orgId, type: body.type };
    },
  };
}
