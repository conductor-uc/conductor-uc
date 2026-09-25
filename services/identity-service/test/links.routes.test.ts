import { createHash } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { enqueueEvent } from '@cuc/events';
import { databaseOrSkipReason, silentLogger } from '@cuc/testing';
import { createServer, type Server } from '@cuc/http';

import { identityEvents } from '../src/events.js';
import { registerAuthRoutes } from '../src/routes/auth.routes.js';
import { registerLinkRoutes } from '../src/routes/links.routes.js';
import { startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();
const INTERNAL_TOKEN = 'test-internal-service-token';
const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a completely different passphrase';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('the reset and invitation events carry no token (G-55)', () => {
  it('declares no token field in either contract', () => {
    for (const type of [
      'identity.user.password_reset_requested',
      'identity.invitation.created',
    ] as const) {
      const contract = identityEvents.contract(type);
      expect(contract.schemaVersion).toBe(2);
      const properties = Object.keys(
        (contract.data as unknown as { properties: Record<string, unknown> }).properties,
      );
      expect(properties.filter((name) => /token|hash|secret/i.test(name))).toEqual([]);
    }
  });

  it('refuses a payload that tries to carry one anyway', () => {
    const base = {
      resetId: 'r-1',
      userId: 'u-1',
      orgId: 'o-1',
      email: 'a@example.test',
      expiresAt: new Date().toISOString(),
    };
    expect(() =>
      identityEvents.assertPayload('identity.user.password_reset_requested', base),
    ).not.toThrow();
    expect(() =>
      identityEvents.assertPayload('identity.user.password_reset_requested', {
        ...base,
        token: 'secret',
      }),
    ).toThrow();
  });
});

describe.skipIf(skipReason !== undefined)('issuing a link at send time (G-55)', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({ serviceName: 'identity-service', logger: silentLogger() });
    registerAuthRoutes(app, h.auth, { cookieSecure: true });
    registerLinkRoutes(app, h.auth, INTERNAL_TOKEN);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    for (const table of [
      'sessions',
      'password_reset_tokens',
      'invitations',
      'users',
      'outbox',
    ] as const) {
      await h.db.kysely.deleteFrom(table).execute();
    }
  });

  const bearer = { authorization: `Bearer ${INTERNAL_TOKEN}` };

  function issue(path: string, headers: Record<string, string> = bearer) {
    return app.inject({ method: 'POST', url: path, headers });
  }

  async function makeUser(orgId: string) {
    return h.users.create(
      { requestId: 'test' },
      {
        orgId,
        orgType: 'tenant',
        resellerId: null,
        email: 'pat@example.test',
        displayName: 'Pat',
        password: PASSWORD,
      },
    );
  }

  async function requestReset(orgId: string): Promise<string> {
    const [requested] = await h.auth.requestPasswordReset(
      { requestId: 'test' },
      orgId,
      'pat@example.test',
    );
    if (requested === undefined) throw new Error('no reset requested');
    return requested.resetId;
  }

  const confirm = (token: string, newPassword = NEW_PASSWORD) =>
    app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset/confirm',
      payload: { token, newPassword },
    });

  describe('password reset', () => {
    const path = (orgId: string, resetId: string) =>
      `/internal/v1/orgs/${orgId}/password-resets/${resetId}/link`;

    it('issues a token, stores only its hash, and the emailed link then works', async () => {
      const orgId = crypto.randomUUID();
      await makeUser(orgId);
      const resetId = await requestReset(orgId);

      const response = await issue(path(orgId, resetId));
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const { token, expiresAt } = response.json<{ token: string; expiresAt: string }>();
      expect(token.length).toBeGreaterThanOrEqual(43);

      const row = await h.db.kysely
        .selectFrom('password_reset_tokens')
        .selectAll()
        .where('id', '=', resetId)
        .executeTakeFirstOrThrow();
      expect(row.token_hash).toBe(sha256(token));
      expect(JSON.stringify(row)).not.toContain(token);
      // The request's own expiry, set when the user asked: issuing does not extend it.
      expect(new Date(expiresAt).getTime()).toBe(row.expires_at.getTime());

      expect((await confirm(token)).statusCode).toBe(204);
    });

    it('a retried email gets a fresh token, and the earlier one stops working', async () => {
      const orgId = crypto.randomUUID();
      await makeUser(orgId);
      const resetId = await requestReset(orgId);

      const first = (await issue(path(orgId, resetId))).json<{ token: string }>().token;
      const second = (await issue(path(orgId, resetId))).json<{ token: string }>().token;
      expect(second).not.toBe(first);

      const stale = await confirm(first);
      expect(stale.statusCode).toBe(400);
      expect(stale.json()).toMatchObject({ code: 'invalid_reset_token' });
      expect((await confirm(second)).statusCode).toBe(204);
    });

    it('a token was never usable before the link is issued', async () => {
      const orgId = crypto.randomUUID();
      await makeUser(orgId);
      await requestReset(orgId);
      // Nothing to present: the row has no hash, and no guess matches NULL.
      expect((await confirm('')).statusCode).toBe(400);
      expect((await confirm('not-a-token')).statusCode).toBe(400);
    });

    it('answers 404 for an unknown reset, or one in another org', async () => {
      const orgId = crypto.randomUUID();
      await makeUser(orgId);
      const resetId = await requestReset(orgId);

      expect((await issue(path(orgId, crypto.randomUUID()))).statusCode).toBe(404);
      expect((await issue(path(crypto.randomUUID(), resetId))).statusCode).toBe(404);
    });

    it('answers 409 once the reset is used', async () => {
      const orgId = crypto.randomUUID();
      await makeUser(orgId);
      const resetId = await requestReset(orgId);
      const token = (await issue(path(orgId, resetId))).json<{ token: string }>().token;
      await confirm(token);

      const again = await issue(path(orgId, resetId));
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ code: 'link_used' });
    });

    it('answers 409 once the reset has expired', async () => {
      const orgId = crypto.randomUUID();
      await makeUser(orgId);
      const resetId = await requestReset(orgId);
      await h.db.kysely
        .updateTable('password_reset_tokens')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .execute();

      const response = await issue(path(orgId, resetId));
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'link_expired' });
    });

    it('answers 409, and issues nothing, when the user was disabled after asking', async () => {
      const orgId = crypto.randomUUID();
      const user = await makeUser(orgId);
      const resetId = await requestReset(orgId);
      await h.db.kysely
        .updateTable('users')
        .set({ status: 'disabled' })
        .where('id', '=', user.id)
        .execute();

      const response = await issue(path(orgId, resetId));
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'user_inactive' });
      const row = await h.db.kysely
        .selectFrom('password_reset_tokens')
        .select('token_hash')
        .executeTakeFirstOrThrow();
      expect(row.token_hash).toBeNull();
    });

    it('refuses a caller without the internal service token', async () => {
      const orgId = crypto.randomUUID();
      await makeUser(orgId);
      const resetId = await requestReset(orgId);

      expect((await issue(path(orgId, resetId), {})).statusCode).toBe(401);
      expect(
        (await issue(path(orgId, resetId), { authorization: 'Bearer wrong-token' })).statusCode,
      ).toBe(401);
      const row = await h.db.kysely
        .selectFrom('password_reset_tokens')
        .select('token_hash')
        .executeTakeFirstOrThrow();
      expect(row.token_hash).toBeNull();
    });
  });

  describe('invitation', () => {
    const path = (orgId: string, invitationId: string) =>
      `/internal/v1/orgs/${orgId}/invitations/${invitationId}/link`;

    async function invite(orgId: string) {
      return h.auth.invite(
        { requestId: 'test' },
        { orgId, orgType: 'tenant', resellerId: null, userId: null },
        { email: 'new@example.test', displayName: 'New Person' },
      );
    }

    const accept = (token: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/accept',
        payload: { token, password: NEW_PASSWORD },
      });

    it('issues a token, stores only its hash, and invalidates an earlier one', async () => {
      const orgId = crypto.randomUUID();
      const invitation = await invite(orgId);

      const first = await issue(path(orgId, invitation.id));
      expect(first.statusCode).toBe(200);
      const firstToken = first.json<{ token: string; expiresAt: string }>().token;
      expect(first.json<{ expiresAt: string }>().expiresAt).toBe(
        invitation.expiresAt.toISOString(),
      );
      const second = (await issue(path(orgId, invitation.id))).json<{ token: string }>().token;

      const row = await h.db.kysely.selectFrom('invitations').selectAll().executeTakeFirstOrThrow();
      expect(row.token_hash).toBe(sha256(second));

      expect((await accept(firstToken)).statusCode).toBe(400);
      expect((await accept(second)).statusCode).toBe(201);
    });

    it('answers 404 for an unknown invitation, or one in another org', async () => {
      const orgId = crypto.randomUUID();
      const invitation = await invite(orgId);
      expect((await issue(path(orgId, crypto.randomUUID()))).statusCode).toBe(404);
      expect((await issue(path(crypto.randomUUID(), invitation.id))).statusCode).toBe(404);
    });

    it('answers 409 once the invitation is accepted', async () => {
      const orgId = crypto.randomUUID();
      const invitation = await invite(orgId);
      const token = (await issue(path(orgId, invitation.id))).json<{ token: string }>().token;
      expect((await accept(token)).statusCode).toBe(201);

      const again = await issue(path(orgId, invitation.id));
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ code: 'link_used' });
    });

    it('answers 409 once the invitation has expired', async () => {
      const orgId = crypto.randomUUID();
      const invitation = await invite(orgId);
      await h.db.kysely
        .updateTable('invitations')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .execute();

      const response = await issue(path(orgId, invitation.id));
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'link_expired' });
    });

    it('refuses a caller without the internal service token', async () => {
      const orgId = crypto.randomUUID();
      const invitation = await invite(orgId);
      expect((await issue(path(orgId, invitation.id), {})).statusCode).toBe(401);
    });

    it('lasts 72 hours from the invitation, however late the link is issued', async () => {
      const orgId = crypto.randomUUID();
      const before = Date.now();
      const invitation = await invite(orgId);
      const lifetime = invitation.expiresAt.getTime() - before;
      expect(lifetime).toBeGreaterThanOrEqual(72 * 60 * 60_000 - 1000);
      expect(lifetime).toBeLessThanOrEqual(72 * 60 * 60_000 + 5000);
    });
  });

  it('the outbox refuses an event that would carry a token', async () => {
    await expect(
      h.db.kysely.transaction().execute(async (trx) =>
        enqueueEvent(trx, identityEvents, {
          type: 'identity.user.password_reset_requested',
          data: {
            resetId: 'r-1',
            userId: 'u-1',
            orgId: 'o-1',
            email: 'a@example.test',
            expiresAt: new Date().toISOString(),
            token: 'secret',
          } as never,
        }),
      ),
    ).rejects.toThrow();
  });
});
