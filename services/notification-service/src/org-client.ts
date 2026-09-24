import type { MailBrandResponse } from './domain/brand.js';

/**
 * Calls org-service's internal mail-brand lookup
 * (`GET /internal/v1/orgs/:id/mail-brand`): the brand an email to a user of
 * that org carries, and where its links should point (02 §5.2). Gated by the
 * shared bearer token org-service's internal routes expect (07 §1's precedent).
 */
export class OrgClientError extends Error {
  override readonly name = 'OrgClientError';
}

export interface OrgClientOptions {
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface OrgClient {
  /** Undefined when org-service has no such org. Throws when it cannot be reached. */
  mailBrand(orgId: string): Promise<MailBrandResponse | undefined>;
}

export function createOrgClient(options: OrgClientOptions): OrgClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  return {
    async mailBrand(orgId) {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/orgs/${encodeURIComponent(orgId)}/mail-brand`,
          {
            headers: { authorization: `Bearer ${options.internalServiceToken}` },
            signal: AbortSignal.timeout(10_000),
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
          `org-service rejected the brand lookup (${String(response.status)}).`,
        );
      }
      return (await response.json()) as MailBrandResponse;
    },
  };
}
