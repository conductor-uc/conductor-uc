/**
 * Calls identity-service's internal link routes (G-55):
 * `POST /internal/v1/orgs/:orgId/password-resets/:resetId/link` and
 * `POST /internal/v1/orgs/:orgId/invitations/:invitationId/link`. The reset
 * and invitation events carry ids only; the one-time token is created by
 * identity-service when this service is about to send the email, and comes
 * back once in the response. Asking again issues a fresh token and the
 * earlier one stops working.
 *
 * The token is a credential. Nothing here logs it, and no error message
 * carries it: errors name the status code only.
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

export interface IdentityClient {
  /** Throws when identity-service cannot be reached or fails. */
  issuePasswordResetLink(orgId: string, resetId: string): Promise<IssuedLink>;
  issueInvitationLink(orgId: string, invitationId: string): Promise<IssuedLink>;
}

export function createIdentityClient(options: IdentityClientOptions): IdentityClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  async function issue(path: string): Promise<IssuedLink> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.internalServiceToken}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new IdentityClientError(
        `Could not reach identity-service (${error instanceof Error ? error.name : 'error'}).`,
      );
    }
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
  };
}
