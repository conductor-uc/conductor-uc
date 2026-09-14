import { ProblemError, Type, type Server } from '@cuc/http';

import {
  InvalidCredentialsError,
  InvalidMfaCodeError,
  InvalidRefreshTokenError,
  RefreshTokenReuseError,
  type RequestMeta,
} from '../auth/auth-service.js';
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

const RefreshBodySchema = Type.Object({ refreshToken: Type.String({ minLength: 1 }) });
const LogoutBodySchema = Type.Object({ refreshToken: Type.String({ minLength: 1 }) });

const TokensSchema = Type.Object({
  accessToken: Type.String(),
  refreshToken: Type.String(),
  expiresIn: Type.Integer(),
});

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
export function registerAuthRoutes(app: Server, auth: AuthService): void {
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
    async (request) => {
      try {
        return await auth.login(
          request.body.orgId,
          request.body.email,
          request.body.password,
          metaOf(request),
        );
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
    async (request) => {
      try {
        return await auth.confirmMfaEnrollment(
          request.body.enrollmentTicket,
          request.body.code,
          metaOf(request),
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
    async (request) => {
      try {
        return await auth.verifyMfa(
          request.body.verificationTicket,
          request.body.code,
          metaOf(request),
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
    async (request) => {
      try {
        return await auth.refresh(request.body.refreshToken, metaOf(request));
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.post(
    '/v1/auth/logout',
    { config: { public: true }, schema: { body: LogoutBodySchema } },
    async (request, reply) => {
      await auth.logout(request.body.refreshToken);
      return reply.status(204).send();
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
  if (error instanceof ProblemError) return error;
  throw error;
}
