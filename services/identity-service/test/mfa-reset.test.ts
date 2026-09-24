import { Secret, TOTP } from 'otpauth';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, silentLogger } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { createOrgAccess } from '../src/authz/org-access.js';
import { registerUserRoutes } from '../src/routes/users.routes.js';
import { startHarness, TEST_META, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();
const SECRET = 'test-internal-header-secret';
const PASSWORD = 'correct horse battery staple';

interface UserBody {
  id: string;
  mfaEnrolled: boolean;
}

function codeFor(base32: string): string {
  return new TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(base32),
  }).generate();
}

describe.skipIf(skipReason !== undefined)('resetting a user’s two-step verification', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({
      serviceName: 'identity-service',
      logger: silentLogger(),
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
    });
    registerUserRoutes(
      app,
      h.users,
      h.roles,
      createOrgAccess({ lineage: () => Promise.resolve(undefined) }),
      h.mfa,
    );
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    for (const table of ['sessions', 'mfa_factors', 'users', 'outbox'] as const) {
      await h.db.kysely.deleteFrom(table).execute();
    }
  });

  /** A reseller-tier user, who must use two-step verification, already enrolled and signed in. */
  async function enrolledUser(orgId: string, email: string) {
    const user = await h.users.create(
      { requestId: 'test' },
      {
        orgId,
        orgType: 'reseller',
        resellerId: orgId,
        email,
        displayName: 'Rae',
        password: PASSWORD,
      },
    );
    const login = await h.auth.login(orgId, email, PASSWORD, TEST_META);
    if (login.status !== 'mfa_enrollment_required') throw new Error('unreachable');
    const tokens = await h.auth.confirmMfaEnrollment(
      login.enrollmentTicket,
      codeFor(login.totp.secret),
      TEST_META,
    );
    return { user, tokens };
  }

  function admin(orgId: string, actorId: string) {
    return signInternalHeaders(SECRET, {
      actorId,
      actorType: 'user',
      orgId,
      orgType: 'reseller',
    });
  }

  async function reset(orgId: string, userId: string, actorId: string) {
    return app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/users/${userId}/mfa-reset`,
      headers: admin(orgId, actorId),
    });
  }

  async function outboxTypes(): Promise<string[]> {
    const rows = await h.db.kysely.selectFrom('outbox').select('type').execute();
    return rows.map((r) => r.type).sort();
  }

  it('declares user.manage and the config data class (CLAUDE.md rule 3)', () => {
    const route = app.registeredRoutes.find((r) => r.url.endsWith('/mfa-reset'));
    expect(route?.permission).toBe('user.manage');
    expect(route?.dataClass).toBe('config');
  });

  it('removes the authenticator, ends every session, and makes the next sign-in enroll again', async () => {
    const orgId = crypto.randomUUID();
    const { user, tokens } = await enrolledUser(orgId, 'rae@example.com');
    const boss = await h.users.create(
      { requestId: 'test' },
      {
        orgId,
        orgType: 'reseller',
        resellerId: orgId,
        email: 'boss@example.com',
        displayName: 'Boss',
        password: PASSWORD,
      },
    );
    await h.db.kysely.deleteFrom('outbox').execute();

    const response = await reset(orgId, user.id, boss.id);
    expect(response.statusCode).toBe(200);
    expect(response.json<UserBody>()).toMatchObject({ id: user.id, mfaEnrolled: false });

    // The authenticator is gone and the old session cannot be renewed.
    expect(await h.mfa.findConfirmedByUser(user.id)).toBeUndefined();
    await expect(h.auth.refresh(tokens.refreshToken, TEST_META)).rejects.toThrow();

    // Signing in asks for a new authenticator, as on a first login, and it works.
    const login = await h.auth.login(orgId, 'rae@example.com', PASSWORD, TEST_META);
    expect(login.status).toBe('mfa_enrollment_required');
    if (login.status !== 'mfa_enrollment_required') return;
    const again = await h.auth.confirmMfaEnrollment(
      login.enrollmentTicket,
      codeFor(login.totp.secret),
      TEST_META,
    );
    expect(again.accessToken).toBeTruthy();
  });

  it('records the reset as an event for the email and as an audit event, together', async () => {
    const orgId = crypto.randomUUID();
    const { user } = await enrolledUser(orgId, 'rae@example.com');
    const boss = await h.users.create(
      { requestId: 'test' },
      {
        orgId,
        orgType: 'reseller',
        resellerId: orgId,
        email: 'boss@example.com',
        displayName: 'Boss',
        password: PASSWORD,
      },
    );
    await h.db.kysely.deleteFrom('outbox').execute();

    await reset(orgId, user.id, boss.id);

    expect(await outboxTypes()).toEqual(['audit.event.recorded', 'identity.user.mfa_reset']);
    const rows = await h.db.kysely.selectFrom('outbox').select(['type', 'payload']).execute();
    const events = new Map(
      rows.map((r) => [
        r.type,
        (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as Record<
          string,
          unknown
        >,
      ]),
    );
    expect(events.get('identity.user.mfa_reset')).toEqual({
      userId: user.id,
      orgId,
      email: 'rae@example.com',
      displayName: 'Rae',
    });
    expect(events.get('audit.event.recorded')).toMatchObject({
      actorId: boss.id,
      targetOrgId: orgId,
      action: 'user.mfa_reset',
      resource: `user:${user.id}`,
    });
    // No secret travels in either.
    expect(JSON.stringify([...events.values()])).not.toMatch(/secret|token/i);
  });

  it('will not reset your own', async () => {
    const orgId = crypto.randomUUID();
    const { user } = await enrolledUser(orgId, 'rae@example.com');
    const response = await reset(orgId, user.id, user.id);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('cannot_reset_self');
    expect(await h.mfa.findConfirmedByUser(user.id)).toBeDefined();
  });

  it('says so when the user never enrolled, and records nothing', async () => {
    const orgId = crypto.randomUUID();
    const boss = await h.users.create(
      { requestId: 'test' },
      {
        orgId,
        orgType: 'tenant',
        resellerId: null,
        email: 'boss@example.com',
        displayName: 'Boss',
        password: PASSWORD,
      },
    );
    const bob = await h.users.create(
      { requestId: 'test' },
      {
        orgId,
        orgType: 'tenant',
        resellerId: null,
        email: 'bob@example.com',
        displayName: 'Bob',
        password: PASSWORD,
      },
    );
    await h.db.kysely.deleteFrom('outbox').execute();

    const response = await reset(orgId, bob.id, boss.id);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('mfa_not_enrolled');
    expect(await outboxTypes()).toEqual([]);
  });

  it('refuses another org’s users, 404s a user who is not here, and needs a signed-in caller', async () => {
    const orgId = crypto.randomUUID();
    const other = crypto.randomUUID();
    const { user: victim } = await enrolledUser(other, 'victim@example.com');
    const boss = await h.users.create(
      { requestId: 'test' },
      {
        orgId,
        orgType: 'reseller',
        resellerId: orgId,
        email: 'boss@example.com',
        displayName: 'Boss',
        password: PASSWORD,
      },
    );

    const foreign = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${other}/users/${victim.id}/mfa-reset`,
      headers: admin(orgId, boss.id),
    });
    expect(foreign.statusCode).toBe(403);
    expect(await h.mfa.findConfirmedByUser(victim.id)).toBeDefined();

    // A user id from another org, asked for through the caller's own org.
    const wrongOrg = await reset(orgId, victim.id, boss.id);
    expect(wrongOrg.statusCode).toBe(404);
    expect(await h.mfa.findConfirmedByUser(victim.id)).toBeDefined();

    const anonymous = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/users/${victim.id}/mfa-reset`,
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
