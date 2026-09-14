import { TOTP, Secret } from 'otpauth';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseOrSkipReason } from '@cuc/testing';

import {
  InvalidCredentialsError,
  InvalidMfaCodeError,
  InvalidRefreshTokenError,
  RefreshTokenReuseError,
} from '../src/auth/auth-service.js';
import { verifyAccessToken } from '../src/tokens/access-token.js';
import { startHarness, TEST_META, TEST_TTL, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();

/** A random UUID-shaped id — org identity is out of this service's scope for S1-05. */
function orgId(): string {
  return crypto.randomUUID();
}

async function createTenantUser(h: Harness, overrides: { password?: string } = {}) {
  const org = orgId();
  const email = `${crypto.randomUUID()}@example.com`;
  const password = overrides.password ?? 'correct horse battery staple';
  const user = await h.users.create(
    {},
    {
      orgId: org,
      orgType: 'tenant',
      resellerId: null,
      email,
      displayName: 'Tenant User',
      password,
    },
  );
  return { org, email, password, user };
}

async function createMasterUser(h: Harness, overrides: { password?: string } = {}) {
  const org = orgId();
  const email = `${crypto.randomUUID()}@example.com`;
  const password = overrides.password ?? 'correct horse battery staple';
  const user = await h.users.create(
    {},
    {
      orgId: org,
      orgType: 'master',
      resellerId: null,
      email,
      displayName: 'Master Admin',
      password,
    },
  );
  return { org, email, password, user };
}

function codeFor(base32: string): string {
  return new TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(base32),
  }).generate();
}

describe.skipIf(skipReason !== undefined)('auth service', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.db.kysely.deleteFrom('sessions').execute();
    await h.db.kysely.deleteFrom('mfa_factors').execute();
    await h.db.kysely.deleteFrom('users').execute();
    await h.db.kysely.deleteFrom('outbox').execute();
  });

  describe('login without MFA (tenant users)', () => {
    it('issues tokens directly for a tenant user', async () => {
      const { org, email, password } = await createTenantUser(h);

      const result = await h.auth.login(org, email, password, TEST_META);

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error('unreachable');
      expect(result.accessToken).toBeTruthy();
      expect(result.refreshToken).toBeTruthy();
      expect(result.expiresIn).toBe(TEST_TTL.accessTokenTtlSeconds);
    });

    it('the issued access token verifies and carries the right claims', async () => {
      const { org, email, password } = await createTenantUser(h);

      const result = await h.auth.login(org, email, password, TEST_META);
      if (result.status !== 'ok') throw new Error('unreachable');

      const claims = await h.auth.verifyAccessTokenForTest(result.accessToken);
      expect(claims).toMatchObject({ org, ot: 'tenant', roles: [], perms: [], amr: ['pwd'] });
      expect(claims.sid).toBeTruthy();
    });

    it('rejects the wrong password without revealing which part was wrong', async () => {
      const { org, email } = await createTenantUser(h);

      await expect(h.auth.login(org, email, 'totally wrong password', TEST_META)).rejects.toThrow(
        InvalidCredentialsError,
      );
    });

    it('rejects an unknown email the same way as a wrong password (no enumeration)', async () => {
      const org = orgId();

      const unknownError = await h.auth
        .login(org, 'nobody@example.com', 'whatever password', TEST_META)
        .catch((e: unknown) => e);
      const { email } = await createTenantUser(h);
      const wrongPasswordError = await h.auth
        .login(org, email, 'wrong password here', TEST_META)
        .catch((e: unknown) => e);

      expect((unknownError as Error).message).toBe((wrongPasswordError as Error).message);
    });
  });

  describe('MFA is required for master and reseller users (07 §1)', () => {
    it('a master user without MFA cannot obtain an access token beyond enrollment — the acceptance criterion', async () => {
      const { org, email, password } = await createMasterUser(h);

      const result = await h.auth.login(org, email, password, TEST_META);

      // Not tokens. A ticket, and enrollment material — nothing that can call
      // an authenticated API.
      expect(result.status).toBe('mfa_enrollment_required');
      if (result.status !== 'mfa_enrollment_required') throw new Error('unreachable');
      expect(result).not.toHaveProperty('accessToken');
      expect(result).not.toHaveProperty('refreshToken');
      expect(result.totp.secret).toMatch(/^[A-Z2-7]+$/);
      expect(result.totp.otpauthUri).toContain('otpauth://totp/');

      // The enrollment ticket itself does not verify as an access token: it
      // carries no org/ot/roles/perms/sid, so nothing that expects those
      // claims would accept it.
      await expect(h.auth.verifyAccessTokenForTest(result.enrollmentTicket)).rejects.toThrow();
    });

    it('confirming enrollment with the right code completes the login and issues real tokens', async () => {
      const { org, email, password } = await createMasterUser(h);
      const login = await h.auth.login(org, email, password, TEST_META);
      if (login.status !== 'mfa_enrollment_required') throw new Error('unreachable');

      const tokens = await h.auth.confirmMfaEnrollment(
        login.enrollmentTicket,
        codeFor(login.totp.secret),
        TEST_META,
      );

      expect(tokens.accessToken).toBeTruthy();
      const claims = await h.auth.verifyAccessTokenForTest(tokens.accessToken);
      expect(claims).toMatchObject({ org, ot: 'master', amr: ['pwd', 'totp'] });
    });

    it('rejects confirming enrollment with the wrong code', async () => {
      const { org, email, password } = await createMasterUser(h);
      const login = await h.auth.login(org, email, password, TEST_META);
      if (login.status !== 'mfa_enrollment_required') throw new Error('unreachable');

      await expect(
        h.auth.confirmMfaEnrollment(login.enrollmentTicket, '000000', TEST_META),
      ).rejects.toThrow(InvalidMfaCodeError);
    });

    it('a subsequent login (after enrollment) asks for verification, not enrollment again', async () => {
      const { org, email, password } = await createMasterUser(h);
      const first = await h.auth.login(org, email, password, TEST_META);
      if (first.status !== 'mfa_enrollment_required') throw new Error('unreachable');
      await h.auth.confirmMfaEnrollment(
        first.enrollmentTicket,
        codeFor(first.totp.secret),
        TEST_META,
      );

      const second = await h.auth.login(org, email, password, TEST_META);

      expect(second.status).toBe('mfa_verification_required');
    });

    it('verifying with the right code issues tokens; the wrong code is rejected', async () => {
      const { org, email, password } = await createMasterUser(h);
      const enroll = await h.auth.login(org, email, password, TEST_META);
      if (enroll.status !== 'mfa_enrollment_required') throw new Error('unreachable');
      const secret = enroll.totp.secret;
      await h.auth.confirmMfaEnrollment(enroll.enrollmentTicket, codeFor(secret), TEST_META);

      const login = await h.auth.login(org, email, password, TEST_META);
      if (login.status !== 'mfa_verification_required') throw new Error('unreachable');

      await expect(h.auth.verifyMfa(login.verificationTicket, '000000', TEST_META)).rejects.toThrow(
        InvalidMfaCodeError,
      );
      const tokens = await h.auth.verifyMfa(login.verificationTicket, codeFor(secret), TEST_META);
      expect(tokens.accessToken).toBeTruthy();
    });

    it('applies the same requirement to a reseller user', async () => {
      const org = orgId();
      const email = `${crypto.randomUUID()}@example.com`;
      await h.users.create(
        {},
        {
          orgId: org,
          orgType: 'reseller',
          resellerId: null,
          email,
          displayName: 'Reseller Admin',
          password: 'correct horse battery staple',
        },
      );

      const result = await h.auth.login(org, email, 'correct horse battery staple', TEST_META);

      expect(result.status).toBe('mfa_enrollment_required');
    });

    it('an unconfirmed enrollment does not by itself authenticate anything', async () => {
      const { org, email, password } = await createMasterUser(h);
      const login = await h.auth.login(org, email, password, TEST_META);
      if (login.status !== 'mfa_enrollment_required') throw new Error('unreachable');

      // The right ticket, but no code was ever supplied — a leaked ticket
      // alone is not enough.
      await expect(
        h.auth.confirmMfaEnrollment(login.enrollmentTicket, '000000', TEST_META),
      ).rejects.toThrow(InvalidMfaCodeError);
    });
  });

  describe('refresh rotation and reuse detection — the acceptance criterion', () => {
    it('rotates: the old token stops working, a new one works', async () => {
      const { org, email, password } = await createTenantUser(h);
      const login = await h.auth.login(org, email, password, TEST_META);
      if (login.status !== 'ok') throw new Error('unreachable');

      const rotated = await h.auth.refresh(login.refreshToken, TEST_META);

      expect(rotated.refreshToken).not.toBe(login.refreshToken);
      expect(rotated.accessToken).toBeTruthy();
    });

    it('reusing an already-rotated refresh token revokes the whole family', async () => {
      const { org, email, password } = await createTenantUser(h);
      const login = await h.auth.login(org, email, password, TEST_META);
      if (login.status !== 'ok') throw new Error('unreachable');

      const rotated = await h.auth.refresh(login.refreshToken, TEST_META);

      // Replaying the old (already-rotated) token is the reuse.
      await expect(h.auth.refresh(login.refreshToken, TEST_META)).rejects.toThrow(
        RefreshTokenReuseError,
      );

      // And the family is now entirely dead: the token from the legitimate
      // rotation that just happened no longer works either — presenting any
      // token from an already-revoked family is treated the same way,
      // whichever token in the chain triggered the revocation.
      await expect(h.auth.refresh(rotated.refreshToken, TEST_META)).rejects.toThrow(
        RefreshTokenReuseError,
      );
    });

    it('keeps rotating across a longer chain', async () => {
      const { org, email, password } = await createTenantUser(h);
      const login = await h.auth.login(org, email, password, TEST_META);
      if (login.status !== 'ok') throw new Error('unreachable');

      let current = login.refreshToken;
      for (let i = 0; i < 4; i += 1) {
        const next = await h.auth.refresh(current, TEST_META);
        current = next.refreshToken;
      }

      await expect(h.auth.refresh(current, TEST_META)).resolves.toBeDefined();
    });

    it('reusing a token from partway through a longer chain still revokes everything', async () => {
      const { org, email, password } = await createTenantUser(h);
      const login = await h.auth.login(org, email, password, TEST_META);
      if (login.status !== 'ok') throw new Error('unreachable');

      const step1 = await h.auth.refresh(login.refreshToken, TEST_META);
      const step2 = await h.auth.refresh(step1.refreshToken, TEST_META);
      await h.auth.refresh(step2.refreshToken, TEST_META);

      // Replay a token from the middle of the chain, not just the very first.
      await expect(h.auth.refresh(step1.refreshToken, TEST_META)).rejects.toThrow(
        RefreshTokenReuseError,
      );
    });

    it('rejects an unknown refresh token', async () => {
      await expect(h.auth.refresh('not-a-real-token', TEST_META)).rejects.toThrow(
        InvalidRefreshTokenError,
      );
    });

    it('a rotated token carries fresh claims, not the original session id', async () => {
      const { org, email, password } = await createTenantUser(h);
      const login = await h.auth.login(org, email, password, TEST_META);
      if (login.status !== 'ok') throw new Error('unreachable');
      const originalClaims = await h.auth.verifyAccessTokenForTest(login.accessToken);

      const rotated = await h.auth.refresh(login.refreshToken, TEST_META);
      const rotatedClaims = await h.auth.verifyAccessTokenForTest(rotated.accessToken);

      expect(rotatedClaims.sid).not.toBe(originalClaims.sid);
    });
  });

  describe('logout', () => {
    it('revokes the session so its refresh token no longer works', async () => {
      const { org, email, password } = await createTenantUser(h);
      const login = await h.auth.login(org, email, password, TEST_META);
      if (login.status !== 'ok') throw new Error('unreachable');

      await h.auth.logout(login.refreshToken);

      await expect(h.auth.refresh(login.refreshToken, TEST_META)).rejects.toThrow();
    });

    it('is idempotent: logging out an already-revoked token is not an error', async () => {
      const { org, email, password } = await createTenantUser(h);
      const login = await h.auth.login(org, email, password, TEST_META);
      if (login.status !== 'ok') throw new Error('unreachable');

      await h.auth.logout(login.refreshToken);

      await expect(h.auth.logout(login.refreshToken)).resolves.toBeUndefined();
    });

    it('logging out one session does not revoke a sibling session from another login', async () => {
      const { org, email, password } = await createTenantUser(h);
      const loginA = await h.auth.login(org, email, password, TEST_META);
      const loginB = await h.auth.login(org, email, password, TEST_META);
      if (loginA.status !== 'ok' || loginB.status !== 'ok') throw new Error('unreachable');

      await h.auth.logout(loginA.refreshToken);

      await expect(h.auth.refresh(loginB.refreshToken, TEST_META)).resolves.toBeDefined();
    });
  });

  describe('JWKS-verifiable end to end', () => {
    it('verifyAccessToken works from just the JWKS-shaped verification keys', async () => {
      const { org, email, password } = await createTenantUser(h);
      const login = await h.auth.login(org, email, password, TEST_META);
      if (login.status !== 'ok') throw new Error('unreachable');

      const keys = await h.db.kysely
        .selectFrom('signing_keys')
        .select(['id', 'public_key'])
        .execute();
      expect(keys).toHaveLength(1);

      // Rebuilt the way the JWKS route and verifyAccessToken both do it —
      // proves the public half alone (no decryption, no KEK) is sufficient.
      const { importJWK } = await import('jose');
      const verificationKeys = await Promise.all(
        keys.map(async (row) => ({
          id: row.id,
          publicKey: await importJWK(
            { kty: 'OKP', crv: 'Ed25519', x: row.public_key.toString('base64url') },
            'EdDSA',
          ),
        })),
      );

      const claims = await verifyAccessToken(login.accessToken, verificationKeys);
      expect(claims.org).toBe(org);
    });
  });
});
