/**
 * Calls identity-service's internal admin-user-creation endpoint
 * (`POST /internal/v1/orgs/:orgId/admin-user`, S1-05) so that creating a
 * reseller or a tenant also creates its first admin user (06's org-service
 * "Depends on: identity-service"), and so that `bootstrap-master` can create
 * the master's first administrator (G-115).
 *
 * Gated by the same shared bearer token identity-service's own internal
 * routes expect (07 §1's precedent for FS nodes and OpenSIPs) — real
 * service-to-service auth does not exist yet.
 *
 * `AdminUserCreator` is the interface routes depend on, not this module
 * directly, so a route test can inject a fake instead of needing a live
 * identity-service listening on a real port.
 */

export interface AdminUserInput {
  readonly orgId: string;
  readonly orgType: 'master' | 'reseller' | 'tenant';
  /** Null for a master's or reseller's own admin; the owning reseller's id for a tenant's. */
  readonly resellerId: string | null;
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
  /**
   * Create the user only if the org has no users yet; otherwise identity-service
   * answers 409 `org_has_users` ({@link OrgHasUsersError}) and creates nothing.
   */
  readonly firstUserOnly?: boolean;
}

export interface CreatedAdminUser {
  readonly id: string;
  readonly email: string;
}

export type AdminUserCreator = (input: AdminUserInput) => Promise<CreatedAdminUser>;

export class AdminUserCreationError extends Error {
  override readonly name = 'AdminUserCreationError';
}

/** identity-service rejected the email as already taken (409). */
export class AdminUserEmailTakenError extends Error {
  override readonly name = 'AdminUserEmailTakenError';
}

/** `firstUserOnly` was set and the org already has users (409 `org_has_users`). */
export class OrgHasUsersError extends Error {
  override readonly name = 'OrgHasUsersError';
}

export interface IdentityClientOptions {
  /** e.g. `http://identity-service:8080`. No trailing slash required. */
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export function createIdentityClient(options: IdentityClientOptions): {
  readonly createAdminUser: AdminUserCreator;
} {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  return {
    async createAdminUser(input: AdminUserInput): Promise<CreatedAdminUser> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/orgs/${encodeURIComponent(input.orgId)}/admin-user`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${options.internalServiceToken}`,
            },
            body: JSON.stringify({
              orgType: input.orgType,
              ...(input.resellerId === null ? {} : { resellerId: input.resellerId }),
              email: input.email,
              displayName: input.displayName,
              password: input.password,
              ...(input.firstUserOnly === true ? { firstUserOnly: true } : {}),
            }),
          },
        );
      } catch (error) {
        throw new AdminUserCreationError(
          `Could not reach identity-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (response.status === 409) {
        const problem = await problemOf(response);
        if (problem.code === 'org_has_users') throw new OrgHasUsersError(problem.detail);
        throw new AdminUserEmailTakenError(problem.detail);
      }
      if (!response.ok) {
        throw new AdminUserCreationError(
          `identity-service rejected admin-user creation (${String(response.status)}): ` +
            (await problemOf(response)).detail,
        );
      }

      const body = (await response.json()) as { id: string; email: string };
      return { id: body.id, email: body.email };
    },
  };
}

async function problemOf(response: Response): Promise<{ code?: string; detail: string }> {
  try {
    const body = (await response.json()) as { code?: string; title?: string; detail?: string };
    return {
      ...(body.code === undefined ? {} : { code: body.code }),
      detail: body.detail ?? body.title ?? response.statusText,
    };
  } catch {
    return { detail: response.statusText };
  }
}
