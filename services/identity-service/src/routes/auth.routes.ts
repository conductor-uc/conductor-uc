import { ProblemError, Type, type Server } from '@cuc/http';

import {
  InvalidCredentialsError,
  InvalidInvitationError,
  InvalidMfaCodeError,
  InvalidRefreshTokenError,
  InvalidResetTokenError,
  RefreshTokenReuseError,
  type IssuedTokens,
  type RequestMeta,
} from '../auth/auth-service.js';
import { WeakPasswordError } from '../domain/password.js';
import {
  clearRefreshCookieHeader,
  readCookie,
  REFRESH_COOKIE,
  refreshCookieHeader,
  REFRESH_TRANSPORT_HEADER,
} from '../http/refresh-cookie.js';
import { InvitationConflictError } from '../repo/token.repo.js';
import { EmailTakenError } from '../repo/user.repo.js';
import type { createAuthService } from '../auth/auth-service.js';

type AuthService = ReturnType<typeof createAuthService>;

const LoginBodySchema = Type.Object({
  orgId: Type.String({ minLength: 1 }),
  email: Type.String({ minLength: 1 }),
  password: Type.String({ minLength: 1 }),
});

const MfaEnrollConfirmBodySchema = Type.Object({
  enrollmentTicket: Type.String({ minLength: 1 }),
  code: Type.String({ minLength: 1 }),
});

const MfaVerifyBodySchema = Type.Object({
  verificationTicket: Type.String({ minLength: 1 }),
  code: Type.String({ minLength: 1 }),
});

// The refresh token is optional in the body: a browser client keeps it in the
// HttpOnly cookie instead (see http/refresh-cookie.ts).
const RefreshBodySchema = Type.Object({
  refreshToken: Type.Optional(Type.String({ minLength: 1 })),
});
const LogoutBodySchema = Type.Object({
  refreshToken: Type.Optional(Type.String({ minLength: 1 })),
});

const TokensSchema = Type.Object({
  accessToken: Type.String(),
  refreshToken: Type.Optional(Type.String()),
  expiresIn: Type.Integer(),
});

const PasswordResetBodySchema = Type.Object({
  orgId: Type.String({ minLength: 1 }),
  email: Type.String({ minLength: 1 }),
});
const PasswordResetConfirmBodySchema = Type.Object({
  token: Type.String({ minLength: 1 }),
  newPassword: Type.String({ minLength: 1 }),
});
const InvitationTokenBodySchema = Type.Object({ token: Type.String({ minLength: 1 }) });
const InvitationAcceptBodySchema = Type.Object({
  token: Type.String({ minLength: 1 }),
  password: Type.String({ minLength: 1 }),
});
const CreateInvitationBodySchema = Type.Object({
  email: Type.String({ minLength: 1 }),
  displayName: Type.String({ minLength: 1, maxLength: 255 }),
});
const OrgParamsSchema = Type.Object({ orgId: Type.String({ minLength: 1 }) });

export interface AuthRouteOptions {
  /** Adds `Secure` to the refresh cookie. Off only for local plain-HTTP setups. */
  readonly cookieSecure?: boolean;
  readonly refreshTokenTtlDays?: number;
  /**
   * Development only: logs the one-time token of a reset or invitation, for
   * when no mailer is running. The token is a credential; never enable this
   * anywhere real.
   */
  readonly devExposeTokens?: boolean;
}

/**
 * `/v1/auth/*` (06). No route here declares `permission`/`dataClass` — every
 * one of them is reachable by definition before an actor exists, so
 * `config: { public: true }` is the correct use of that escape hatch, not an
 * exception to it.
 *
 * `orgId` is taken directly in each request body. Resolving it from a
 * hostname or subdomain is api-gateway's job (S1-08), which does not exist
 * yet; this is the interim, directly testable shape this task's own API needs.
 */
export function registerAuthRoutes(
  app: Server,
  auth: AuthService,
  options: AuthRouteOptions = {},
): void {
  const secure = options.cookieSecure ?? true;
  const ttlDays = options.refreshTokenTtlDays ?? 30;

  /**
   * Sets the refresh cookie and returns the body to send: with the
   * cookie-transport header the refresh token stays out of it.
   */
  function deliver(
    request: { headers: Record<string, unknown> },
    reply: { header(name: string, value: string): unknown },
    tokens: IssuedTokens,
  ): { accessToken: string; refreshToken?: string; expiresIn: number } {
    void reply.header('set-cookie', refreshCookieHeader(tokens.refreshToken, ttlDays, { secure }));
    const cookieOnly = request.headers[REFRESH_TRANSPORT_HEADER] === 'cookie';
    return cookieOnly ? { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn } : tokens;
  }

  app.post(
    '/v1/auth/login',
    {
      config: { public: true },
      schema: {
        body: LoginBodySchema,
        response: {
          200: Type.Union([
            Type.Object({ status: Type.Literal('ok'), ...TokensSchema.properties }),
            Type.Object({
              status: Type.Literal('mfa_enrollment_required'),
              enrollmentTicket: Type.String(),
              totp: Type.Object({ secret: Type.String(), otpauthUri: Type.String() }),
            }),
            Type.Object({
              status: Type.Literal('mfa_verification_required'),
              verificationTicket: Type.String(),
            }),
          ]),
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await auth.login(
          request.body.orgId,
          request.body.email,
          request.body.password,
          metaOf(request),
        );
        if (result.status !== 'ok') return result;
        const { status: _status, ...tokens } = result;
        return { status: 'ok' as const, ...deliver(request, reply, tokens) };
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.post(
    '/v1/auth/mfa/enroll/confirm',
    {
      config: { public: true },
      schema: { body: MfaEnrollConfirmBodySchema, response: { 200: TokensSchema } },
    },
    async (request, reply) => {
      try {
        return deliver(
          request,
          reply,
          await auth.confirmMfaEnrollment(
            request.body.enrollmentTicket,
            request.body.code,
            metaOf(request),
          ),
        );
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.post(
    '/v1/auth/mfa/verify',
    {
      config: { public: true },
      schema: { body: MfaVerifyBodySchema, response: { 200: TokensSchema } },
    },
    async (request, reply) => {
      try {
        return deliver(
          request,
          reply,
          await auth.verifyMfa(request.body.verificationTicket, request.body.code, metaOf(request)),
        );
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.post(
    '/v1/auth/refresh',
    {
      config: { public: true },
      schema: { body: RefreshBodySchema, response: { 200: TokensSchema } },
    },
    async (request, reply) => {
      const presented =
        request.body.refreshToken ?? readCookie(request.headers.cookie, REFRESH_COOKIE);
      if (presented === undefined) {
        throw ProblemError.unauthorized('No refresh token was presented.', {
          code: 'invalid_refresh_token',
        });
      }
      try {
        return deliver(request, reply, await auth.refresh(presented, metaOf(request)));
      } catch (error) {
        // A dead token should not linger in the browser.
        void reply.header('set-cookie', clearRefreshCookieHeader({ secure }));
        throw toProblem(error);
      }
    },
  );

  app.post(
    '/v1/auth/logout',
    { config: { public: true }, schema: { body: LogoutBodySchema } },
    async (request, reply) => {
      const presented =
        request.body.refreshToken ?? readCookie(request.headers.cookie, REFRESH_COOKIE);
      if (presented !== undefined) await auth.logout(presented);
      void reply.header('set-cookie', clearRefreshCookieHeader({ secure }));
      return reply.status(204).send();
    },
  );

  // Password reset (06). Always 202, whether or not the account exists.
  app.post(
    '/v1/auth/password-reset',
    { config: { public: true }, schema: { body: PasswordResetBodySchema } },
    async (request, reply) => {
      const issued = await auth.requestPasswordReset(
        request.context,
        request.body.orgId,
        request.body.email,
      );
      if (issued !== undefined && options.devExposeTokens === true) {
        request.log.warn(
          { email: issued.email, token: issued.token },
          'DEV ONLY: password reset token (no mailer is running)',
        );
      }
      return reply.status(202).send();
    },
  );

  app.post(
    '/v1/auth/password-reset/confirm',
    { config: { public: true }, schema: { body: PasswordResetConfirmBodySchema } },
    async (request, reply) => {
      try {
        await auth.confirmPasswordReset(request.body.token, request.body.newPassword);
      } catch (error) {
        throw toProblem(error);
      }
      return reply.status(204).send();
    },
  );

  // Invitations. The token is the credential, so both routes are public.
  app.post(
    '/v1/auth/invitations/lookup',
    {
      config: { public: true },
      schema: {
        body: InvitationTokenBodySchema,
        response: { 200: Type.Object({ email: Type.String(), displayName: Type.String() }) },
      },
    },
    async (request) => {
      try {
        return await auth.lookupInvitation(request.body.token);
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.post(
    '/v1/auth/invitations/accept',
    {
      config: { public: true },
      schema: {
        body: InvitationAcceptBodySchema,
        response: { 201: Type.Object({ email: Type.String(), orgId: Type.String() }) },
      },
    },
    async (request, reply) => {
      try {
        const user = await auth.acceptInvitation(
          request.context,
          request.body.token,
          request.body.password,
        );
        return reply.status(201).send({ email: user.email, orgId: user.orgId });
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  // Inviting someone is an authenticated action. Only into the caller's own
  // org for now: identity-service holds no org read model, so it cannot tell
  // what type of org another id names (G-56).
  app.post(
    '/v1/orgs/:orgId/invitations',
    {
      config: { permission: 'user.manage', dataClass: 'config' },
      schema: {
        params: OrgParamsSchema,
        body: CreateInvitationBodySchema,
        response: {
          201: Type.Object({
            id: Type.String(),
            email: Type.String(),
            expiresAt: Type.String(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { orgId, orgType, resellerId, actorId } = request.context;
      if (orgId === undefined || orgType === undefined) {
        throw ProblemError.unauthorized('Sign in to invite someone.');
      }
      if (request.params.orgId !== orgId) {
        throw ProblemError.forbidden('You can only invite people into your own organization.', {
          code: 'invitation_other_org',
        });
      }
      try {
        const invitation = await auth.invite(
          request.context,
          { orgId, orgType, resellerId: resellerId ?? null, userId: actorId ?? null },
          request.body,
        );
        if (options.devExposeTokens === true) {
          request.log.warn(
            { email: invitation.email, token: invitation.token },
            'DEV ONLY: invitation token (no mailer is running)',
          );
        }
        return reply.status(201).send({
          id: invitation.id,
          email: invitation.email,
          expiresAt: invitation.expiresAt.toISOString(),
        });
      } catch (error) {
        throw toProblem(error);
      }
    },
  );
}

function metaOf(request: { headers: Record<string, unknown>; ip?: string }): RequestMeta {
  const ua = request.headers['user-agent'];
  return {
    ip: request.ip ?? null,
    ua: typeof ua === 'string' ? ua : null,
  };
}

/**
 * Maps a domain error to a problem+json response. Every case here is
 * deliberately vague in its message — see the errors' own constructors — so
 * this mapping adds no detail the domain layer did not already choose to
 * reveal.
 */
function toProblem(error: unknown): ProblemError {
  if (error instanceof RefreshTokenReuseError) {
    return ProblemError.unauthorized(error.message, { code: 'refresh_token_reused' });
  }
  if (error instanceof InvalidRefreshTokenError) {
    return ProblemError.unauthorized(error.message, { code: 'invalid_refresh_token' });
  }
  if (error instanceof InvalidCredentialsError) {
    return ProblemError.unauthorized(error.message, { code: 'invalid_credentials' });
  }
  if (error instanceof InvalidMfaCodeError) {
    return ProblemError.unauthorized(error.message, { code: 'invalid_mfa_code' });
  }
  if (error instanceof InvalidResetTokenError) {
    return ProblemError.badRequest(error.message, { code: 'invalid_reset_token' });
  }
  if (error instanceof InvalidInvitationError) {
    return ProblemError.badRequest(error.message, { code: 'invalid_invitation' });
  }
  if (error instanceof WeakPasswordError) {
    return ProblemError.badRequest(error.message, { code: 'weak_password' });
  }
  if (error instanceof EmailTakenError) {
    return ProblemError.conflict('That email already has an account in this organization.', {
      code: 'email_taken',
    });
  }
  if (error instanceof InvitationConflictError) {
    return ProblemError.conflict(error.message, { code: 'invitation_open' });
  }
  if (error instanceof ProblemError) return error;
  throw error;
}
