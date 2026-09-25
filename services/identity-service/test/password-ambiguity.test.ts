import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, silentLogger } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { registerAuthRoutes } from '../src/routes/auth.routes.js';
import { registerInternalRoutes } from '../src/routes/internal.routes.js';
import { startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();
const SECRET = 'test-internal-header-secret';
const INTERNAL_TOKEN = 'test-internal-service-token';
const SHARED = 'correct horse battery staple';
const OTHER_PASSWORD = 'a different long passphrase';
const EMAIL = 'pat@example.test';

const ACME = 'org-acme';
const OTHER_RESELLER = 'org-other';
const DENTAL = 'org-acme-dental';
const CAFE = 'org-acme-cafe';
const OTHER_CAFE = 'org-other-cafe';

/**
 * G-61: at a reseller's console the same email may exist in several tenants and
 * the password tells them apart, so two accounts that share both cannot be
 * created.
 */
describe.skipIf(skipReason !== undefined)('two accounts must not share email and password', () => {
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
    registerInternalRoutes(app, h.users, h.roles, INTERNAL_TOKEN);
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
      'role_assignments',
      'users',
      'outbox',
    ] as const) {
      await h.db.kysely.deleteFrom(table).execute();
    }
  });

  function makeUser(orgId: string, resellerId: string | null, password = SHARED) {
    return h.users.create(
      { requestId: 'test' },
      {
        orgId,
        orgType: 'tenant',
        resellerId,
        email: EMAIL,
        displayName: 'Pat',
        password,
      },
    );
  }

  /** Invites [EMAIL] into a tenant as its reseller would, and returns the mailed token. */
  async function invitationFor(orgId: string, resellerId: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/invitations`,
      headers: signInternalHeaders(SECRET, {
        actorId: 'admin-1',
        actorType: 'user',
        orgId,
        orgType: 'tenant',
        resellerId,
      }),
      payload: { email: EMAIL, displayName: 'Pat' },
    });
    expect(response.statusCode).toBe(201);
    // The link is issued when the email is sent (G-55), as notification-service does.
    const link = await h.auth.issueInvitationLink(orgId, response.json<{ id: string }>().id);
    if (link.status !== 'issued') throw new Error(link.status);
    return link.token;
  }

  const accept = (token: string, password: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/auth/invitations/accept',
      payload: { token, password },
    });

  describe('accepting an invitation', () => {
    it('refuses a password that already opens the same address in another tenant of the reseller', async () => {
      await makeUser(DENTAL, ACME);
      const token = await invitationFor(CAFE, ACME);

      const refused = await accept(token, SHARED);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'password_in_use' });
      expect(await h.users.findByOrgAndEmail(CAFE, EMAIL)).toBeUndefined();
    });

    it('leaves the invitation open, so a different password can be chosen', async () => {
      await makeUser(DENTAL, ACME);
      const token = await invitationFor(CAFE, ACME);
      expect((await accept(token, SHARED)).statusCode).toBe(409);
      expect((await accept(token, OTHER_PASSWORD)).statusCode).toBe(201);
      expect(await h.users.findByOrgAndEmail(CAFE, EMAIL)).toBeDefined();
    });

    it('does not mind the same address and password under a different reseller', async () => {
      await makeUser(OTHER_CAFE, OTHER_RESELLER);
      const token = await invitationFor(CAFE, ACME);
      expect((await accept(token, SHARED)).statusCode).toBe(201);
    });

    it('does not say anything about an account whose password was not guessed', async () => {
      await makeUser(DENTAL, ACME, OTHER_PASSWORD);
      const token = await invitationFor(CAFE, ACME);
      // The same answer as if the address were new: created.
      expect((await accept(token, SHARED)).statusCode).toBe(201);
    });

    it('does not count a disabled account', async () => {
      const existing = await makeUser(DENTAL, ACME);
      await h.users.update({ requestId: 'test' }, DENTAL, existing.id, { status: 'disabled' });
      const token = await invitationFor(CAFE, ACME);
      expect((await accept(token, SHARED)).statusCode).toBe(201);
    });

    it("counts the reseller's own user too, since they sign in at the same console", async () => {
      await h.users.create(
        { requestId: 'test' },
        {
          orgId: ACME,
          orgType: 'reseller',
          resellerId: null,
          email: EMAIL,
          displayName: 'Pat',
          password: SHARED,
        },
      );
      const token = await invitationFor(CAFE, ACME);
      expect((await accept(token, SHARED)).statusCode).toBe(409);
    });
  });

  describe('resetting a password', () => {
    async function resetToken(userId: string): Promise<string> {
      const user = await h.users.findById(userId);
      const requested = await h.auth.requestPasswordReset(
        { requestId: 'test' },
        user!.orgId,
        EMAIL,
      );
      for (const one of requested) {
        if (one.orgId !== user!.orgId) continue;
        const link = await h.auth.issuePasswordResetLink(one.orgId, one.resetId);
        if (link.status === 'issued') return link.token;
      }
      throw new Error(`no reset for ${userId}`);
    }

    const confirm = (token: string, newPassword: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset/confirm',
        payload: { token, newPassword },
      });

    it('refuses a new password that opens another account with the address, without spending the link', async () => {
      await makeUser(DENTAL, ACME, SHARED);
      const cafe = await makeUser(CAFE, ACME, OTHER_PASSWORD);
      const token = await resetToken(cafe.id);

      const refused = await confirm(token, SHARED);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'password_in_use' });

      // The same link still works with a password that is not in use.
      const ok = await confirm(token, 'yet another long passphrase');
      expect(ok.statusCode).toBe(204);
    });

    it("allows keeping one's own password", async () => {
      const cafe = await makeUser(CAFE, ACME, SHARED);
      const token = await resetToken(cafe.id);
      expect((await confirm(token, SHARED)).statusCode).toBe(204);
    });
  });

  describe('creating an org admin', () => {
    const create = (orgId: string, resellerId: string | null, password: string) =>
      app.inject({
        method: 'POST',
        url: `/internal/v1/orgs/${orgId}/admin-user`,
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
        payload: {
          orgType: 'tenant',
          ...(resellerId === null ? {} : { resellerId }),
          email: EMAIL,
          displayName: 'Pat',
          password,
        },
      });

    it('refuses an admin whose password would collide with the same address in the reseller', async () => {
      await makeUser(DENTAL, ACME);
      const refused = await create(CAFE, ACME, SHARED);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'password_in_use' });
      expect((await create(CAFE, ACME, OTHER_PASSWORD)).statusCode).toBe(201);
    });
  });
});
