import { decryptString, encrypt, type KekProvider } from '@cuc/crypto';
import type { DbContext } from '@cuc/db';

import { generateTotpSecret, verifyTotpCode } from '../domain/totp.js';
import { assertPasswordStrength, verifyPassword } from '../domain/password.js';
import type { MfaRepo } from '../repo/mfa.repo.js';
import type { SessionRepo } from '../repo/session.repo.js';
import type { SigningKeyRepo } from '../repo/signing-key.repo.js';
import type { TokenRepo } from '../repo/token.repo.js';
import type { User, UserRepo } from '../repo/user.repo.js';
import {
  signAccessToken,
  verifyAccessToken,
  type AccessTokenClaims,
} from '../tokens/access-token.js';
import { signTicket, verifyTicket } from '../tokens/ticket.js';

export class InvalidCredentialsError extends Error {
  override readonly name = 'InvalidCredentialsError';

  constructor() {
    // Deliberately generic: whether the email or the password was wrong is
    // not revealed, so a login failure cannot be used to enumerate accounts.
    super('Invalid email or password.');
  }
}

export class InvalidMfaCodeError extends Error {
  override readonly name = 'InvalidMfaCodeError';

  constructor() {
    super('Invalid or expired code.');
  }
}

export class InvalidRefreshTokenError extends Error {
  override readonly name = 'InvalidRefreshTokenError';
}

export class RefreshTokenReuseError extends Error {
  override readonly name = 'RefreshTokenReuseError';
  readonly familyId: string;

  constructor(familyId: string) {
    super('This refresh token was already used. Every session in its family has been revoked.');
    this.familyId = familyId;
  }
}

export class InvalidResetTokenError extends Error {
  override readonly name = 'InvalidResetTokenError';

  constructor() {
    super('This reset link is invalid or has expired.');
  }
}

export class InvalidInvitationError extends Error {
  override readonly name = 'InvalidInvitationError';

  constructor() {
    super('This invitation is invalid or has expired.');
  }
}

export interface RequestMeta {
  readonly ip: string | null;
  readonly ua: string | null;
}

export interface IssuedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

export type LoginResult =
  | ({ readonly status: 'ok' } & IssuedTokens)
  | {
      readonly status: 'mfa_enrollment_required';
      readonly enrollmentTicket: string;
      readonly totp: { readonly secret: string; readonly otpauthUri: string };
    }
  | { readonly status: 'mfa_verification_required'; readonly verificationTicket: string };

export interface AuthServiceOptions {
  readonly users: UserRepo;
  readonly sessions: SessionRepo;
  readonly mfa: MfaRepo;
  readonly signingKeys: SigningKeyRepo;
  readonly tokens: TokenRepo;
  readonly kek: KekProvider;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlDays: number;
  readonly mfaTicketTtlSeconds: number;
  readonly signingKeyOverlapDays: number;
  readonly passwordResetTtlMinutes: number;
  readonly invitationTtlDays: number;
}

/**
 * Orchestrates login, MFA enrollment and verification, refresh rotation, and
 * logout (07 §1–2). Every repository call in here is where a permission check
 * would eventually go (S1-06); today, reaching these functions at all is the
 * access control — see the note on `IdentityServiceDb` in `schema.ts`.
 */
export function createAuthService(options: AuthServiceOptions) {
  const {
    users,
    sessions,
    mfa,
    signingKeys,
    tokens,
    kek,
    accessTokenTtlSeconds,
    refreshTokenTtlDays,
    mfaTicketTtlSeconds,
    signingKeyOverlapDays,
    passwordResetTtlMinutes,
    invitationTtlDays,
  } = options;

  /** 07 §1: MFA is required for master and reseller users. */
  function mfaRequired(user: User): boolean {
    return user.orgType === 'master' || user.orgType === 'reseller';
  }

  async function issueTokens(
    user: User,
    session: { sessionId: string; refreshToken: string },
    amr: readonly string[],
  ): Promise<IssuedTokens> {
    const key = await signingKeys.current();
    const claims: Omit<AccessTokenClaims, 'sub' | 'iat' | 'exp'> & { sub: string } = {
      sub: user.id,
      org: user.orgId,
      ot: user.orgType,
      ...(user.resellerId === null ? {} : { rsl: user.resellerId }),
      roles: [],
      perms: [],
      amr,
      sid: session.sessionId,
    };
    const accessToken = await signAccessToken(key, claims, accessTokenTtlSeconds);
    return { accessToken, refreshToken: session.refreshToken, expiresIn: accessTokenTtlSeconds };
  }

  return {
    /**
     * Email + password. Returns tokens directly only when the org type needs
     * no MFA. A master or reseller user always gets a ticket instead — never
     * a token — until a second factor is proven (07 §1's own acceptance
     * criterion: "cannot obtain an access token beyond MFA enrollment").
     */
    async login(
      orgId: string,
      email: string,
      password: string,
      meta: RequestMeta,
    ): Promise<LoginResult> {
      const user = await users.findByOrgAndEmail(orgId, email);
      if (user === undefined || user.status !== 'active') throw new InvalidCredentialsError();
      if (!(await verifyPassword(user.passwordHash, password))) throw new InvalidCredentialsError();

      await users.recordLogin(user.id);

      if (!mfaRequired(user)) {
        const session = await sessions.create(user.id, refreshTokenTtlDays, meta);
        return { status: 'ok', ...(await issueTokens(user, session, ['pwd'])) };
      }

      if (!user.mfaEnrolled) {
        const secret = generateTotpSecret(orgDisplayName(user), user.email);
        const secretEnc = await encrypt(kek, secret.base32, mfaEncAssociatedDataForUser(user.id));
        const factor = await mfa.createPending(user.id, secretEnc);
        const key = await signingKeys.current();
        const enrollmentTicket = await signTicket(
          key,
          { sub: user.id, typ: 'mfa_enroll', fid: factor.id },
          mfaTicketTtlSeconds,
        );
        return {
          status: 'mfa_enrollment_required',
          enrollmentTicket,
          totp: { secret: secret.base32, otpauthUri: secret.otpauthUri },
        };
      }

      const confirmed = await mfa.findConfirmedByUser(user.id);
      if (confirmed === undefined) throw new InvalidCredentialsError();
      const key = await signingKeys.current();
      const verificationTicket = await signTicket(
        key,
        { sub: user.id, typ: 'mfa_verify', fid: confirmed.id },
        mfaTicketTtlSeconds,
      );
      return { status: 'mfa_verification_required', verificationTicket };
    },

    /**
     * Completes enrollment: the code proves possession of the secret just
     * issued, which is also sufficient to complete the login it started from.
     */
    async confirmMfaEnrollment(
      enrollmentTicket: string,
      code: string,
      meta: RequestMeta,
    ): Promise<IssuedTokens> {
      const verificationKeys = await signingKeys.forVerification(signingKeyOverlapDays);
      const claims = await verifyOrTicketError(() =>
        verifyTicket(enrollmentTicket, verificationKeys, 'mfa_enroll'),
      );

      const factor = await mfa.findById(claims.fid);
      if (factor === undefined || factor.userId !== claims.sub || factor.confirmed) {
        throw new InvalidMfaCodeError();
      }

      const secretBase32 = await decryptString(
        kek,
        factor.secretEnc,
        mfaEncAssociatedDataForUser(claims.sub),
      );
      if (!verifyTotpCode(secretBase32, code)) throw new InvalidMfaCodeError();

      const confirmed = await mfa.confirm(claims.sub, factor.id);
      if (!confirmed) throw new InvalidMfaCodeError();

      const user = await users.findById(claims.sub);
      if (user === undefined) throw new InvalidMfaCodeError();

      const session = await sessions.create(user.id, refreshTokenTtlDays, meta);
      return issueTokens(user, session, ['pwd', 'totp']);
    },

    /** Completes a login that returned `mfa_verification_required`. */
    async verifyMfa(
      verificationTicket: string,
      code: string,
      meta: RequestMeta,
    ): Promise<IssuedTokens> {
      const verificationKeys = await signingKeys.forVerification(signingKeyOverlapDays);
      const claims = await verifyOrTicketError(() =>
        verifyTicket(verificationTicket, verificationKeys, 'mfa_verify'),
      );

      const user = await users.findById(claims.sub);
      if (user === undefined) throw new InvalidMfaCodeError();

      const factor = await mfa.findConfirmedByUser(user.id);
      if (factor === undefined) throw new InvalidMfaCodeError();

      const secretBase32 = await decryptString(
        kek,
        factor.secretEnc,
        mfaEncAssociatedDataForUser(user.id),
      );
      if (!verifyTotpCode(secretBase32, code)) throw new InvalidMfaCodeError();

      const session = await sessions.create(user.id, refreshTokenTtlDays, meta);
      return issueTokens(user, session, ['pwd', 'totp']);
    },

    /**
     * Rotates a refresh token. A token that has already been rotated once
     * (`revokedAt` set) is a reuse: every session in its family is revoked,
     * on the assumption the whole chain is compromised (07 §2).
     */
    async refresh(refreshToken: string, meta: RequestMeta): Promise<IssuedTokens> {
      const found = await sessions.findByToken(refreshToken);
      if (found === undefined) throw new InvalidRefreshTokenError('Unknown refresh token.');

      if (found.revokedAt !== null) {
        await sessions.revokeFamily(found.familyId);
        throw new RefreshTokenReuseError(found.familyId);
      }
      if (found.expiresAt.getTime() <= Date.now()) {
        throw new InvalidRefreshTokenError('Refresh token has expired.');
      }

      const user = await users.findById(found.userId);
      if (user === undefined || user.status !== 'active')
        throw new InvalidRefreshTokenError('User no longer active.');

      const rotated = await sessions.rotate(
        found.id,
        found.userId,
        found.familyId,
        refreshTokenTtlDays,
        meta,
      );
      // amr is not carried forward from the original login; a refreshed token
      // asserts only that the refresh token itself was valid.
      return issueTokens(user, rotated, ['pwd']);
    },

    /** Idempotent: revoking a token that is already gone is not an error. */
    async logout(refreshToken: string): Promise<void> {
      const found = await sessions.findByToken(refreshToken);
      if (found !== undefined) await sessions.revoke(found.id);
    },

    /**
     * Starts a password reset. Says nothing about whether the account exists:
     * the caller answers 202 either way, so this cannot be used to find out
     * who has an account. Returns the token only so a dev-mode flag can log it
     * when no mailer is running; it is never part of an HTTP response.
     */
    async requestPasswordReset(
      ctx: DbContext,
      orgId: string,
      email: string,
    ): Promise<{ token: string; email: string } | undefined> {
      const user = await users.findByOrgAndEmail(orgId, email);
      if (user === undefined || user.status !== 'active') return undefined;
      const { token } = await tokens.createPasswordReset(ctx, user, passwordResetTtlMinutes);
      return { token, email: user.email };
    },

    /**
     * Sets a new password from a reset token, and signs the user out
     * everywhere. The strength check comes first so a weak password does not
     * spend the token.
     */
    async confirmPasswordReset(token: string, newPassword: string): Promise<void> {
      assertPasswordStrength(newPassword);
      const userId = await tokens.consumePasswordReset(token);
      if (userId === undefined) throw new InvalidResetTokenError();
      await users.setPassword(userId, newPassword);
      await sessions.revokeAllForUser(userId);
    },

    /** Invites a person into the actor's own org. */
    async invite(
      ctx: DbContext,
      actor: {
        readonly orgId: string;
        readonly orgType: User['orgType'];
        readonly resellerId: string | null;
        readonly userId: string | null;
      },
      input: { readonly email: string; readonly displayName: string },
    ) {
      return tokens.createInvitation(
        ctx,
        {
          orgId: actor.orgId,
          orgType: actor.orgType,
          resellerId: actor.resellerId,
          email: input.email,
          displayName: input.displayName,
          invitedBy: actor.userId,
        },
        invitationTtlDays,
      );
    },

    /** Who an invitation is for, so the accept page can say so. */
    async lookupInvitation(token: string): Promise<{ email: string; displayName: string }> {
      const invitation = await tokens.findOpenInvitation(token);
      if (invitation === undefined) throw new InvalidInvitationError();
      return { email: invitation.email, displayName: invitation.displayName };
    },

    /** Accepts an invitation: creates the user with their chosen password. */
    async acceptInvitation(ctx: DbContext, token: string, password: string): Promise<User> {
      assertPasswordStrength(password);
      const invitation = await tokens.findOpenInvitation(token);
      if (invitation === undefined) throw new InvalidInvitationError();
      const user = await users.create(ctx, {
        orgId: invitation.orgId,
        orgType: invitation.orgType,
        resellerId: invitation.resellerId,
        email: invitation.email,
        displayName: invitation.displayName,
        password,
      });
      await tokens.markInvitationAccepted(invitation.id);
      return user;
    },

    /**
     * Verifies an access token this service minted. For this service's own
     * tests; api-gateway (S1-08) is the intended verifier in production.
     */
    async verifyAccessTokenForTest(token: string): Promise<AccessTokenClaims> {
      const keys = await signingKeys.forVerification(signingKeyOverlapDays);
      return verifyAccessToken(token, keys);
    },
  };

  function mfaEncAssociatedDataForUser(userId: string): string {
    // A fixed string, not the factor id: at enrollment time no factor row
    // exists yet to bind to, and rebinding to the user id keeps encrypt/decrypt
    // symmetric across both call sites.
    return `mfa_factors.secret_enc:user:${userId}`;
  }
}

async function verifyOrTicketError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    throw new InvalidMfaCodeError();
  }
}

/**
 * The TOTP issuer shown in an authenticator app: the org's own name, never a
 * fixed product or operator name (02 §5.2). `users` does not carry the org's
 * display name today — only its id — so this is a placeholder until that is
 * available; it still avoids the brand leak the real thing must avoid.
 */
function orgDisplayName(user: User): string {
  return user.orgId;
}
