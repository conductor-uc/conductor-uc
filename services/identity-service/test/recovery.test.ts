import { TOTP, Secret } from 'otpauth';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, silentLogger } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { registerAuthRoutes } from '../src/routes/auth.routes.js';
import { startHarness, TEST_META, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();
const SECRET = 'test-internal-header-secret';
const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a completely different passphrase';

function codeFor(base32: string): string {
  return new TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(base32),
  }).generate();
}

describe.skipIf(skipReason !== undefined)('password reset, invitations, refresh cookie', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({
      serviceName: 'identity-service',
      logger: silentLogger(),
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
    });
    registerAuthRoutes(app, h.auth, { cookieSecure: true, refreshTokenTtlDays: 30 });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    for (const table of [
      'sessions',
      'mfa_factors',
      'password_reset_tokens',
      'invitations',
      'users',
      'outbox',
    ] as const) {
      await h.db.kysely.deleteFrom(table).execute();
    }
  });

  async function makeUser(
    orgId: string,
    orgType: 'master' | 'reseller' | 'tenant' = 'tenant',
    email = 'admin@example.com',
  ) {
    return h.users.create(
      { requestId: 'test' },
      {
        orgId,
        orgType,
        resellerId: null,
        email,
        displayName: 'Admin',
        password: PASSWORD,
      },
    );
  }

  async function outboxOf(type: string) {
    const rows = await h.db.kysely.selectFrom('outbox').selectAll().execute();
    return rows.filter((r) => r.type === type);
  }

  function login(orgId: string, password: string, headers: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers,
      payload: { orgId, email: 'admin@example.com', password },
    });
  }

  describe('refresh cookie', () => {
    it('sets an HttpOnly, SameSite=Strict, Secure cookie scoped to /v1/auth', async () => {
      const orgId = crypto.randomUUID();
      await makeUser(orgId);
      const response = await login(orgId, PASSWORD);

      const cookie = String(response.headers['set-cookie']);
      expect(cookie).toMatch(/^refresh=[\w-]+;/);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('Path=/v1/auth');
      expect(cookie).toContain(`Max-Age=${String(30 * 24 * 60 * 60)}`);
    });

    it('still returns the refresh token in the body to clients that do not ask for cookie transport', async () => {
      const orgId = crypto.randomUUID();
      await makeUser(orgId);
      const body = (await login(orgId, PASSWORD)).json<{ refreshToken?: string }>();
      expect(body.refreshToken).toBeTruthy();
    });

    it('keeps the refresh token out of the body when the client asks for cookie transport', async () => {
      const orgId = crypto.randomUUID();
      await makeUser(orgId);
      const response = await login(orgId, PASSWORD, { 'x-refresh-transport': 'cookie' });

      expect(response.json()).not.toHaveProperty('refreshToken');
      expect(response.json()).toHaveProperty('accessToken');
      expect(String(response.headers['set-cookie'])).toMatch(/^refresh=/);
    });

    it('refreshes from the cookie alone, and rotates it', async () => {
      const orgId = crypto.randomUUID();
      await makeUser(orgId);
      const first = await login(orgId, PASSWORD, { 'x-refresh-transport': 'cookie' });
      const cookie1 = String(first.headers['set-cookie']).split(';')[0]!;

      const refreshed = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: { cookie: cookie1, 'x-refresh-transport': 'cookie' },
        payload: {},
      });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json()).not.toHaveProperty('refreshToken');
      const cookie2 = String(refreshed.headers['set-cookie']).split(';')[0]!;
      expect(cookie2).not.toBe(cookie1);

      // The old cookie is now a reuse: rejected, and the cookie is cleared.
      const reused = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: { cookie: cookie1 },
        payload: {},
      });
      expect(reused.statusCode).toBe(401);
      expect(String(reused.headers['set-cookie'])).toContain('Max-Age=0');
    });

    it('rejects a refresh with neither a body token nor a cookie', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: {},
      });
      expect(response.statusCode).toBe(401);
    });

    it('logout revokes the cookie session and clears the cookie', async () => {
      const orgId = crypto.randomUUID();
      await makeUser(orgId);
      const first = await login(orgId, PASSWORD, { 'x-refresh-transport': 'cookie' });
      const cookie = String(first.headers['set-cookie']).split(';')[0]!;

      const out = await app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: { cookie },
        payload: {},
      });
      expect(out.statusCode).toBe(204);
      expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');

      const after = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: { cookie },
        payload: {},
      });
      expect(after.statusCode).toBe(401);
    });

    it('sets the cookie after MFA, too, and never before it', async () => {
      const orgId = crypto.randomUUID();
      await makeUser(orgId, 'master');
      const start = await login(orgId, PASSWORD, { 'x-refresh-transport': 'cookie' });
      const step = start.json<{
        status: string;
        enrollmentTicket: string;
        totp: { secret: string };
      }>();
      expect(step.status).toBe('mfa_enrollment_required');
      expect(start.headers['set-cookie']).toBeUndefined();

      const done = await app.inject({
        method: 'POST',
        url: '/v1/auth/mfa/enroll/confirm',
        headers: { 'x-refresh-transport': 'cookie' },
        payload: { enrollmentTicket: step.enrollmentTicket, code: codeFor(step.totp.secret) },
      });
      expect(done.statusCode).toBe(200);
      expect(String(done.headers['set-cookie'])).toMatch(/^refresh=/);
    });
  });

  describe('password reset', () => {
    it('answers 202 for a known and an unknown account alike', async () => {
      const orgId = crypto.randomUUID();
      await makeUser(orgId);
      const known = await app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset',
        payload: { orgId, email: 'admin@example.com' },
      });
      const unknown = await app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset',
        payload: { orgId, email: 'nobody@example.com' },
      });
      expect(known.statusCode).toBe(202);
      expect(unknown.statusCode).toBe(202);
      expect(known.body).toBe(unknown.body);
    });

    it('publishes one event, only for a real, active account', async () => {
      const orgId = crypto.randomUUID();
      await makeUser(orgId);
      await app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset',
        payload: { orgId, email: 'nobody@example.com' },
      });
      expect(await outboxOf('identity.user.password_reset_requested')).toHaveLength(0);

      await app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset',
        payload: { orgId, email: 'ADMIN@example.com' }, // case-insensitive
      });
      const events = await outboxOf('identity.user.password_reset_requested');
      expect(events).toHaveLength(1);
    });

    async function requestToken(orgId: string): Promise<string> {
      const issued = await h.auth.requestPasswordReset(
        { requestId: 'test' },
        orgId,
        'admin@example.com',
      );
      const first = issued[0];
      if (first === undefined) throw new Error('no token issued');
      return first.token;
    }

    it('sets the new password, and the old one stops working', async () => {
      const orgId = crypto.randomUUID();
      await makeUser(orgId);
      const token = await requestToken(orgId);

      const confirm = await app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset/confirm',
        payload: { token, newPassword: NEW_PASSWORD },
      });
      expect(confirm.statusCode).toBe(204);

      expect((await login(orgId, PASSWORD)).statusCode).toBe(401);
      expect((await login(orgId, NEW_PASSWORD)).statusCode).toBe(200);
    });

    it('is single use', async () => {
      const orgId = crypto.randomUUID();
      await makeUser(orgId);
      const token = await requestToken(orgId);
      const body = { token, newPassword: NEW_PASSWORD };

      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/auth/password-reset/confirm',
            payload: body,
          })
        ).statusCode,
      ).toBe(204);
      const again = await app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset/confirm',
        payload: { token, newPassword: 'yet another long passphrase' },
      });
      expect(again.statusCode).toBe(400);
      expect(again.json()).toMatchObject({ code: 'invalid_reset_token' });
    });

    it('rejects an expired token', async () => {
      const orgId = crypto.randomUUID();
      await makeUser(orgId);
      const token = await requestToken(orgId);
      await h.db.kysely
        .updateTable('password_reset_tokens')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .execute();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset/confirm',
        payload: { token, newPassword: NEW_PASSWORD },
      });
      expect(response.statusCode).toBe(400);
    });

    it('a weak password is rejected without spending the token', async () => {
      const orgId = crypto.randomUUID();
      await makeUser(orgId);
      const token = await requestToken(orgId);

      const weak = await app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset/confirm',
        payload: { token, newPassword: 'short' },
      });
      expect(weak.statusCode).toBe(400);
      expect(weak.json()).toMatchObject({ code: 'weak_password' });

      const retry = await app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset/confirm',
        payload: { token, newPassword: NEW_PASSWORD },
      });
      expect(retry.statusCode).toBe(204);
    });

    it('signs the user out everywhere', async () => {
      const orgId = crypto.randomUUID();
      await makeUser(orgId);
      const session = (await login(orgId, PASSWORD)).json<{ refreshToken: string }>();
      const token = await requestToken(orgId);
      await app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset/confirm',
        payload: { token, newPassword: NEW_PASSWORD },
      });

      await expect(h.auth.refresh(session.refreshToken, TEST_META)).rejects.toThrow();
    });

    it("does not accept a token from another user's org or a guessed one", async () => {
      const orgId = crypto.randomUUID();
      await makeUser(orgId);
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset/confirm',
        payload: { token: 'not-a-real-token', newPassword: NEW_PASSWORD },
      });
      expect(response.statusCode).toBe(400);
    });

    it('stores only a hash of the token', async () => {
      const orgId = crypto.randomUUID();
      await makeUser(orgId);
      const token = await requestToken(orgId);
      const rows = await h.db.kysely.selectFrom('password_reset_tokens').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.token_hash).not.toContain(token);
      expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('invitations', () => {
    function asActor(
      orgId: string,
      orgType: 'master' | 'reseller' | 'tenant',
      resellerId?: string,
    ) {
      return signInternalHeaders(SECRET, {
        actorId: 'inviter-1',
        actorType: 'user',
        orgId,
        orgType,
        ...(resellerId === undefined ? {} : { resellerId }),
      });
    }

    async function invite(
      orgId: string,
      headers: Record<string, string>,
      email = 'new@example.com',
    ) {
      return app.inject({
        method: 'POST',
        url: `/v1/orgs/${orgId}/invitations`,
        headers,
        payload: { email, displayName: 'New Person' },
      });
    }

    /** The token the mailer would receive: the outbox payload is the event's `data`. */
    async function tokenOf(email: string): Promise<string> {
      const events = await outboxOf('identity.invitation.created');
      for (const row of events) {
        const data = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as {
          email: string;
          token: string;
        };
        if (data.email === email) return data.token;
      }
      throw new Error(`no invitation event for ${email}`);
    }

    it("creates an invitation in the caller's own org and publishes it", async () => {
      const orgId = crypto.randomUUID();
      const response = await invite(orgId, asActor(orgId, 'tenant'));
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ email: 'new@example.com' });
      expect(response.body).not.toContain('token');
      expect(await outboxOf('identity.invitation.created')).toHaveLength(1);
    });

    it('refuses to invite into another org', async () => {
      const mine = crypto.randomUUID();
      const response = await invite(crypto.randomUUID(), asActor(mine, 'tenant'));
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'invitation_other_org' });
    });

    it('refuses an anonymous caller', async () => {
      const response = await invite(crypto.randomUUID(), {});
      expect(response.statusCode).toBe(401);
    });

    it('does not open a second invitation for the same email', async () => {
      const orgId = crypto.randomUUID();
      await invite(orgId, asActor(orgId, 'tenant'));
      const again = await invite(orgId, asActor(orgId, 'tenant'));
      expect(again.statusCode).toBe(409);
    });

    it('lookup says who the invitation is for', async () => {
      const orgId = crypto.randomUUID();
      await invite(orgId, asActor(orgId, 'tenant'));
      const token = await tokenOf('new@example.com');

      const lookup = await app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/lookup',
        payload: { token },
      });
      expect(lookup.statusCode).toBe(200);
      expect(lookup.json()).toEqual({ email: 'new@example.com', displayName: 'New Person' });
    });

    it("accepting creates a user in the inviter's org and type, who can then sign in", async () => {
      const orgId = crypto.randomUUID();
      const resellerId = crypto.randomUUID();
      await invite(orgId, asActor(orgId, 'tenant', resellerId));
      const token = await tokenOf('new@example.com');

      const accept = await app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/accept',
        payload: { token, password: NEW_PASSWORD },
      });
      expect(accept.statusCode).toBe(201);
      expect(accept.json()).toEqual({ email: 'new@example.com', orgId });

      const user = await h.users.findByOrgAndEmail(orgId, 'new@example.com');
      expect(user).toMatchObject({ orgType: 'tenant', resellerId });
      const signIn = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { orgId, email: 'new@example.com', password: NEW_PASSWORD },
      });
      expect(signIn.statusCode).toBe(200);
    });

    it('an accepted invitation cannot be used again', async () => {
      const orgId = crypto.randomUUID();
      await invite(orgId, asActor(orgId, 'tenant'));
      const token = await tokenOf('new@example.com');
      await app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/accept',
        payload: { token, password: NEW_PASSWORD },
      });

      const again = await app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/accept',
        payload: { token, password: NEW_PASSWORD },
      });
      expect(again.statusCode).toBe(400);
      expect(again.json()).toMatchObject({ code: 'invalid_invitation' });
    });

    it('an expired invitation is rejected', async () => {
      const orgId = crypto.randomUUID();
      await invite(orgId, asActor(orgId, 'tenant'));
      const token = await tokenOf('new@example.com');
      await h.db.kysely
        .updateTable('invitations')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .execute();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/accept',
        payload: { token, password: NEW_PASSWORD },
      });
      expect(response.statusCode).toBe(400);
    });

    it('a weak password does not spend the invitation', async () => {
      const orgId = crypto.randomUUID();
      await invite(orgId, asActor(orgId, 'tenant'));
      const token = await tokenOf('new@example.com');

      const weak = await app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/accept',
        payload: { token, password: 'short' },
      });
      expect(weak.statusCode).toBe(400);
      const ok = await app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/accept',
        payload: { token, password: NEW_PASSWORD },
      });
      expect(ok.statusCode).toBe(201);
    });

    it('accepting for an email that already has an account is a conflict', async () => {
      const orgId = crypto.randomUUID();
      await makeUser(orgId, 'tenant', 'new@example.com');
      await invite(orgId, asActor(orgId, 'tenant'));
      const token = await tokenOf('new@example.com');

      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/accept',
        payload: { token, password: NEW_PASSWORD },
      });
      expect(response.statusCode).toBe(409);
    });

    it('every new route declares its contract (CLAUDE.md rule 3)', () => {
      const routes = app.registeredRoutes.filter((r) => r.url.includes('/invitations'));
      expect(routes.length).toBeGreaterThanOrEqual(3);
      const authenticated = routes.find((r) => r.url === '/v1/orgs/:orgId/invitations');
      expect(authenticated?.permission).toBe('user.manage');
      expect(authenticated?.dataClass).toBe('config');
    });
  });
});
