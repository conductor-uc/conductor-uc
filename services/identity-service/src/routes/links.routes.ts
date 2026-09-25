import { secretEquals } from '@cuc/crypto';
import { ProblemError, Type, type Server } from '@cuc/http';

import type { createAuthService } from '../auth/auth-service.js';
import type { LinkIssue } from '../repo/token.repo.js';

type AuthService = ReturnType<typeof createAuthService>;

const ResetParamsSchema = Type.Object({
  orgId: Type.String({ minLength: 1 }),
  resetId: Type.String({ minLength: 1 }),
});

const InvitationParamsSchema = Type.Object({
  orgId: Type.String({ minLength: 1 }),
  invitationId: Type.String({ minLength: 1 }),
});

const LinkSchema = Type.Object({
  /** The one-time token the emailed link carries. Returned once, stored nowhere. */
  token: Type.String(),
  expiresAt: Type.String(),
});

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token !== undefined && token !== '' ? token : undefined;
}

/**
 * `POST /internal/v1/orgs/:orgId/password-resets/:resetId/link` and
 * `POST /internal/v1/orgs/:orgId/invitations/:invitationId/link` (G-55): what
 * notification-service calls when it is about to send a reset or invitation
 * email. The events that ask for those emails carry ids only; the token is
 * created here, at send time, its SHA-256 replaces any earlier one (so a link
 * issued for an email that was then retried stops working), and the raw token
 * goes back once in this response. No outbox row, stream message or backup
 * ever holds a usable one.
 *
 * - 200 `{ token, expiresAt }`. The expiry is the reset's or invitation's own,
 *   set when it was created; issuing again does not extend it.
 * - 404 when there is no such reset or invitation in that org, or the user it
 *   was for no longer exists.
 * - 409 `link_used` (reset done, invitation accepted), `link_expired`, or
 *   `user_inactive` (the user was disabled after asking).
 *
 * Neither 404 nor 409 is worth retrying: the caller sends no email. Gated by
 * the shared internal token, like this service's other internal routes; the
 * api-gateway routes nothing under `/internal`.
 */
export function registerLinkRoutes(
  app: Server,
  auth: Pick<AuthService, 'issuePasswordResetLink' | 'issueInvitationLink'>,
  internalServiceToken: string,
): void {
  function authorize(header: string | undefined): void {
    const presented = bearerToken(header);
    if (presented === undefined || !secretEquals(internalServiceToken, presented)) {
      throw ProblemError.unauthorized('A valid internal service token is required.');
    }
  }

  function answer(issue: LinkIssue, what: 'password reset' | 'invitation') {
    switch (issue.status) {
      case 'issued':
        return { token: issue.token, expiresAt: issue.expiresAt.toISOString() };
      case 'not_found':
        throw ProblemError.notFound(`No such ${what} in that organization.`);
      case 'used':
        throw ProblemError.conflict(`That ${what} has already been used.`, { code: 'link_used' });
      case 'expired':
        throw ProblemError.conflict(`That ${what} has expired.`, { code: 'link_expired' });
      case 'user_inactive':
        throw ProblemError.conflict('That user is no longer active.', { code: 'user_inactive' });
    }
  }

  app.post(
    '/internal/v1/orgs/:orgId/password-resets/:resetId/link',
    {
      config: { public: true },
      schema: { params: ResetParamsSchema, response: { 200: LinkSchema } },
    },
    async (request, reply) => {
      authorize(request.headers.authorization);
      const issue = await auth.issuePasswordResetLink(request.params.orgId, request.params.resetId);
      void reply.header('cache-control', 'no-store');
      return answer(issue, 'password reset');
    },
  );

  app.post(
    '/internal/v1/orgs/:orgId/invitations/:invitationId/link',
    {
      config: { public: true },
      schema: { params: InvitationParamsSchema, response: { 200: LinkSchema } },
    },
    async (request, reply) => {
      authorize(request.headers.authorization);
      const issue = await auth.issueInvitationLink(
        request.params.orgId,
        request.params.invitationId,
      );
      void reply.header('cache-control', 'no-store');
      return answer(issue, 'invitation');
    },
  );
}
