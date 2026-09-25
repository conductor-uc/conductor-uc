import { Secret, TOTP } from 'otpauth';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, silentLogger } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { createStepUp, STEP_UP_LOCKOUT_MS, STEP_UP_MAX_FAILURES } from '../src/auth/step-up.js';
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

function codeFor(base32: string, timestamp = Date.now()): string {
  return new TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(base32),
  }).generate({ timestamp });
}

/** A code that is surely not the current one (nor either neighbour). */
function wrongCodeFor(base32: string, timestamp = Date.now()): string {
  const valid = new Set([-30_000, 0, 30_000].map((d) => codeFor(base32, timestamp + d)));
  for (let n = 0; ; n += 1) {
    const candidate = String(n).padStart(6, '0');
    if (!valid.has(candidate)) return candidate;
  }
}

describe.skipIf(skipReason !== undefined)('resetting a user’s two-step verification', () => {
  let h: Harness;
  let app: Server;
  /** The clock step-up checks codes against; tests move it forward. */
  let clock = Date.now();

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
      createStepUp({ mfa: h.mfa, kek: h.kek, now: () => clock }),
    );
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    clock = Date.now();
    for (const table of ['sessions', 'mfa_factors', 'users', 'outbox'] as const) {
      await h.db.kysely.deleteFrom(table).execute();
    }
  });

  /**
   * A reseller-tier user, who must use two-step verification, already
   * enrolled and signed in. `totp` is their authenticator's secret.
   */
  async function enrolledUser(orgId: string, email: string, displayName = 'Rae') {
    const user = await h.users.create(
      { requestId: 'test' },
      {
        orgId,
        orgType: 'reseller',
        resellerId: orgId,
        email,
        displayName,
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
    return { user, tokens, totp: login.totp.secret };
  }

  /** Rae (to be reset) and Boss (resetting), both enrolled, in one reseller org. */
  async function raeAndBoss() {
    const orgId = crypto.randomUUID();
    const rae = await enrolledUser(orgId, 'rae@example.com');
    const boss = await enrolledUser(orgId, 'boss@example.com', 'Boss');
    await h.db.kysely.deleteFrom('outbox').execute();
    return { orgId, rae, boss };
  }

  function admin(orgId: string, actorId: string) {
    return signInternalHeaders(SECRET, {
      actorId,
      actorType: 'user',
      orgId,
      orgType: 'reseller',
    });
  }

  async function reset(orgId: string, userId: string, actorId: string, stepUpCode?: string) {
    return app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/users/${userId}/mfa-reset`,
      headers: admin(orgId, actorId),
      ...(stepUpCode === undefined ? {} : { payload: { stepUpCode } }),
    });
  }

  async function outboxTypes(): Promise<string[]> {
    const rows = await h.db.kysely.selectFrom('outbox').select('type').execute();
    return rows.map((r) => r.type).sort();
  }

  async function auditPayloads(): Promise<Record<string, unknown>[]> {
    const rows = await h.db.kysely
      .selectFrom('outbox')
      .select('payload')
      .where('type', '=', 'audit.event.recorded')
      .execute();
    return rows.map(
      (r) =>
        (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as Record<
          string,
          unknown
        >,
    );
  }

  it('declares user.manage and the config data class (CLAUDE.md rule 3)', () => {
    const route = app.registeredRoutes.find((r) => r.url.endsWith('/mfa-reset'));
    expect(route?.permission).toBe('user.manage');
    expect(route?.dataClass).toBe('config');
  });

  it('removes the authenticator, ends every session, and makes the next sign-in enroll again', async () => {
    const { orgId, rae, boss } = await raeAndBoss();

    const response = await reset(orgId, rae.user.id, boss.user.id, codeFor(boss.totp));
    expect(response.statusCode).toBe(200);
    expect(response.json<UserBody>()).toMatchObject({ id: rae.user.id, mfaEnrolled: false });

    // The authenticator is gone and the old session cannot be renewed.
    expect(await h.mfa.findConfirmedByUser(rae.user.id)).toBeUndefined();
    await expect(h.auth.refresh(rae.tokens.refreshToken, TEST_META)).rejects.toThrow();

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
    const { orgId, rae, boss } = await raeAndBoss();

    await reset(orgId, rae.user.id, boss.user.id, codeFor(boss.totp));

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
      userId: rae.user.id,
      orgId,
      email: 'rae@example.com',
      displayName: 'Rae',
    });
    expect(events.get('audit.event.recorded')).toMatchObject({
      actorId: boss.user.id,
      targetOrgId: orgId,
      action: 'user.mfa_reset',
      resource: `user:${rae.user.id}`,
    });
    // No secret travels in either.
    expect(JSON.stringify([...events.values()])).not.toMatch(/secret|token/i);
  });

  it('will not reset your own', async () => {
    const orgId = crypto.randomUUID();
    const { user, totp } = await enrolledUser(orgId, 'rae@example.com');
    const response = await reset(orgId, user.id, user.id, codeFor(totp));
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

    // Checked before any code is asked for: there is nothing to confirm.
    const response = await reset(orgId, bob.id, boss.id);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('mfa_not_enrolled');
    expect(await outboxTypes()).toEqual([]);
  });

  it('refuses another org’s users, 404s a user who is not here, and needs a signed-in caller', async () => {
    const orgId = crypto.randomUUID();
    const other = crypto.randomUUID();
    const { user: victim } = await enrolledUser(other, 'victim@example.com');
    const boss = await enrolledUser(orgId, 'boss@example.com', 'Boss');

    const foreign = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${other}/users/${victim.id}/mfa-reset`,
      headers: admin(orgId, boss.user.id),
      payload: { stepUpCode: codeFor(boss.totp) },
    });
    expect(foreign.statusCode).toBe(403);
    expect(await h.mfa.findConfirmedByUser(victim.id)).toBeDefined();

    // A user id from another org, asked for through the caller's own org.
    const wrongOrg = await reset(orgId, victim.id, boss.user.id, codeFor(boss.totp));
    expect(wrongOrg.statusCode).toBe(404);
    expect(await h.mfa.findConfirmedByUser(victim.id)).toBeDefined();

    const anonymous = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/users/${victim.id}/mfa-reset`,
    });
    expect(anonymous.statusCode).toBe(401);
  });

  describe('step-up confirmation (G-100)', () => {
    it('without a code: 401 step_up_required, and nothing changes or is recorded', async () => {
      const { orgId, rae, boss } = await raeAndBoss();

      for (const response of [
        await reset(orgId, rae.user.id, boss.user.id),
        await reset(orgId, rae.user.id, boss.user.id, ''),
        await reset(orgId, rae.user.id, boss.user.id, '   '),
      ]) {
        expect(response.statusCode).toBe(401);
        expect(response.json<{ code: string }>().code).toBe('step_up_required');
      }
      expect(await h.mfa.findConfirmedByUser(rae.user.id)).toBeDefined();
      expect(await outboxTypes()).toEqual([]);
    });

    it('a wrong code: 401 step_up_invalid, nothing changes, and the failure is audited without the code', async () => {
      const { orgId, rae, boss } = await raeAndBoss();
      const wrong = wrongCodeFor(boss.totp);

      const response = await reset(orgId, rae.user.id, boss.user.id, wrong);
      expect(response.statusCode).toBe(401);
      expect(response.json<{ code: string }>().code).toBe('step_up_invalid');
      expect(await h.mfa.findConfirmedByUser(rae.user.id)).toBeDefined();

      // Only the audit event: no reset, no email.
      expect(await outboxTypes()).toEqual(['audit.event.recorded']);
      const [audit] = await auditPayloads();
      expect(audit).toMatchObject({
        actorId: boss.user.id,
        actorOrgId: orgId,
        targetOrgId: orgId,
        action: 'auth.step_up_failed',
        resource: `user:${boss.user.id}`,
        reason: 'user.mfa_reset: invalid_code',
      });
      expect(JSON.stringify(audit)).not.toContain(wrong);
    });

    it('someone else’s code does not count: it must be the acting admin’s own', async () => {
      const { orgId, rae, boss } = await raeAndBoss();
      const response = await reset(orgId, rae.user.id, boss.user.id, codeFor(rae.totp));
      expect(response.statusCode).toBe(401);
      expect(response.json<{ code: string }>().code).toBe('step_up_invalid');
      expect(await h.mfa.findConfirmedByUser(rae.user.id)).toBeDefined();
    });

    it('a code confirms one action only: a replay is refused, a later code works', async () => {
      const orgId = crypto.randomUUID();
      const rae = await enrolledUser(orgId, 'rae@example.com');
      const sam = await enrolledUser(orgId, 'sam@example.com', 'Sam');
      const boss = await enrolledUser(orgId, 'boss@example.com', 'Boss');
      await h.db.kysely.deleteFrom('outbox').execute();

      const code = codeFor(boss.totp, clock);
      expect((await reset(orgId, rae.user.id, boss.user.id, code)).statusCode).toBe(200);

      const replay = await reset(orgId, sam.user.id, boss.user.id, code);
      expect(replay.statusCode).toBe(401);
      expect(replay.json<{ code: string }>().code).toBe('step_up_invalid');
      expect(await h.mfa.findConfirmedByUser(sam.user.id)).toBeDefined();
      const failures = (await auditPayloads()).filter((a) => a['action'] === 'auth.step_up_failed');
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ reason: 'user.mfa_reset: replayed_code' });

      // Half a minute later the authenticator shows a new code, and it works.
      clock += 30_000;
      const next = await reset(orgId, sam.user.id, boss.user.id, codeFor(boss.totp, clock));
      expect(next.statusCode).toBe(200);
    });

    it('an admin with no authenticator of their own is refused: 403 step_up_not_enrolled', async () => {
      const orgId = crypto.randomUUID();
      const rae = await enrolledUser(orgId, 'rae@example.com');
      // Created directly, never signed in: no second factor.
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

      for (const code of [undefined, '123456']) {
        const response = await reset(orgId, rae.user.id, boss.id, code);
        expect(response.statusCode).toBe(403);
        expect(response.json<{ code: string }>().code).toBe('step_up_not_enrolled');
      }
      expect(await h.mfa.findConfirmedByUser(rae.user.id)).toBeDefined();
    });

    it(`${String(STEP_UP_MAX_FAILURES)} wrong codes lock step-up for a while, even for a right code`, async () => {
      const { orgId, rae, boss } = await raeAndBoss();

      for (let i = 0; i < STEP_UP_MAX_FAILURES; i += 1) {
        const response = await reset(orgId, rae.user.id, boss.user.id, wrongCodeFor(boss.totp));
        expect(response.statusCode).toBe(401);
      }
      const locked = await reset(orgId, rae.user.id, boss.user.id, codeFor(boss.totp, clock));
      expect(locked.statusCode).toBe(429);
      expect(locked.json<{ code: string }>().code).toBe('step_up_locked');
      expect(await h.mfa.findConfirmedByUser(rae.user.id)).toBeDefined();
      expect((await auditPayloads()).map((a) => a['reason'])).toContain('user.mfa_reset: locked');

      // Once the window has passed since the last wrong code, a right code works again.
      clock += STEP_UP_LOCKOUT_MS + 1_000;
      const later = await reset(orgId, rae.user.id, boss.user.id, codeFor(boss.totp, clock));
      expect(later.statusCode).toBe(200);
    });

    it('wrong codes spread out over time do not add up to a lockout', async () => {
      const { orgId, rae, boss } = await raeAndBoss();
      for (let i = 0; i < STEP_UP_MAX_FAILURES; i += 1) {
        await reset(orgId, rae.user.id, boss.user.id, wrongCodeFor(boss.totp, clock));
        clock += STEP_UP_LOCKOUT_MS + 1_000;
      }
      const response = await reset(orgId, rae.user.id, boss.user.id, codeFor(boss.totp, clock));
      expect(response.statusCode).toBe(200);
    });
  });
});
