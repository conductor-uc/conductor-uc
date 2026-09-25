/**
 * Calls identity-service's internal routes, gated by the shared bearer token
 * those routes expect (07 §1's precedent):
 *
 * - G-55: `POST /internal/v1/orgs/:orgId/password-resets/:resetId/link` and
 *   `POST /internal/v1/orgs/:orgId/invitations/:invitationId/link`. The reset
 *   and invitation events carry ids only; the one-time token is created by
 *   identity-service when this service is about to send the email, and comes
 *   back once in the response. Asking again issues a fresh token and the
 *   earlier one stops working.
 * - G-100: `GET /internal/v1/orgs/:orgId/admins`, the org's administrators, so
 *   the notice that someone's two-step verification was reset can go to the
 *   org's other admins without the event carrying their addresses.
 *
 * A token is a credential and an address is personal data: nothing here logs
 * either, and no error message carries them. Errors name the status code only.
 */
export class IdentityClientError extends Error {
  override readonly name = 'IdentityClientError';
}

export interface IdentityClientOptions {
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * What asking for a link came to. `refused` (404 or 409) means identity-service
 * will not issue one: the reset or invitation is gone, used or expired, or the
 * user is no longer active. No email should go out, and asking again will not
 * help.
 */
export type IssuedLink =
  | { readonly status: 'issued'; readonly token: string; readonly expiresAt: Date }
  | { readonly status: 'refused'; readonly httpStatus: number; readonly code?: string };

export interface OrgAdmin {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
}

export interface IdentityClient {
  /** Throws when identity-service cannot be reached or fails. */
  issuePasswordResetLink(orgId: string, resetId: string): Promise<IssuedLink>;
  issueInvitationLink(orgId: string, invitationId: string): Promise<IssuedLink>;
  /** The org's active administrators. Throws when identity-service cannot be reached. */
  admins(orgId: string): Promise<OrgAdmin[]>;
}

export function createIdentityClient(options: IdentityClientOptions): IdentityClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const authorization = `Bearer ${options.internalServiceToken}`;

  async function call(path: string, method: 'GET' | 'POST'): Promise<Response> {
    try {
      return await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { authorization },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new IdentityClientError(
        `Could not reach identity-service (${error instanceof Error ? error.name : 'error'}).`,
      );
    }
  }

  async function issue(path: string): Promise<IssuedLink> {
    const response = await call(path, 'POST');
    if (response.status === 404 || response.status === 409) {
      const body = (await response.json().catch(() => ({}))) as { code?: unknown };
      return {
        status: 'refused',
        httpStatus: response.status,
        ...(typeof body.code === 'string' ? { code: body.code } : {}),
      };
    }
    if (!response.ok) {
      throw new IdentityClientError(
        `identity-service refused to issue the link (${String(response.status)}).`,
      );
    }
    const body = (await response.json()) as { token?: unknown; expiresAt?: unknown };
    if (typeof body.token !== 'string' || body.token === '' || typeof body.expiresAt !== 'string') {
      throw new IdentityClientError('identity-service answered without a link.');
    }
    return { status: 'issued', token: body.token, expiresAt: new Date(body.expiresAt) };
  }

  const org = (orgId: string) => `/internal/v1/orgs/${encodeURIComponent(orgId)}`;

  return {
    issuePasswordResetLink: (orgId, resetId) =>
      issue(`${org(orgId)}/password-resets/${encodeURIComponent(resetId)}/link`),
    issueInvitationLink: (orgId, invitationId) =>
      issue(`${org(orgId)}/invitations/${encodeURIComponent(invitationId)}/link`),
    async admins(orgId) {
      const response = await call(`${org(orgId)}/admins`, 'GET');
      if (!response.ok) {
        throw new IdentityClientError(
          `identity-service rejected the admins lookup (${String(response.status)}).`,
        );
      }
      return ((await response.json()) as { rows: OrgAdmin[] }).rows;
    },
  };
}
