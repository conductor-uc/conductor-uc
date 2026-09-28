import { Secret, TOTP } from 'otpauth';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, silentLogger } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { createStepUp } from '../src/auth/step-up.js';
import { registerSecuritySettingsRoutes } from '../src/routes/security-settings.routes.js';
import { startHarness, TEST_META, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();
const SECRET = 'test-internal-header-secret';
const PASSWORD = 'correct horse battery staple';

function codeFor(base32: string): string {
  return new TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(base32),
  }).generate();
}

describe.skipIf(skipReason !== undefined)('the platform sign-in settings', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({
      serviceName: 'identity-service',
      logger: silentLogger(),
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
    });
    registerSecuritySettingsRoutes(
      app,
      h.securitySettings,
      createStepUp({ mfa: h.mfa, kek: h.kek }),
    );
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
      'users',
      'outbox',
      'platform_security_settings',
    ] as const) {
      await h.db.kysely.deleteFrom(table).execute();
    }
  });

  function as(orgId: string, actorId: string, orgType: 'master' | 'reseller' = 'master') {
    return signInternalHeaders(SECRET, { actorId, actorType: 'user', orgId, orgType });
  }

  async function put(headers: Record<string, string>, payload: Record<string, unknown>) {
    return app.inject({ method: 'PUT', url: '/v1/platform/security-settings', headers, payload });
  }

  /** A master administrator who has enrolled; `totp` is their authenticator's secret. */
  async function enrolledMaster() {
    const orgId = crypto.randomUUID();
    const user = await h.users.create(
      {},
      {
        orgId,
        orgType: 'master',
        resellerId: null,
        email: 'op@example.com',
        displayName: 'Operator',
        password: PASSWORD,
      },
    );
    await h.securitySettings.save({ actorId: user.id, orgId }, { requireMasterMfa: true });
    const login = await h.auth.login(orgId, 'op@example.com', PASSWORD, TEST_META);
    if (login.status !== 'mfa_enrollment_required') throw new Error('unreachable');
    await h.auth.confirmMfaEnrollment(
      login.enrollmentTicket,
      codeFor(login.totp.secret),
      TEST_META,
    );
    return { orgId, user, totp: login.totp.secret };
  }

  it('starts off on a fresh install', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/platform/security-settings',
      headers: as(crypto.randomUUID(), crypto.randomUUID()),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ requireMasterMfa: false, updatedAt: null });
  });

  it('is the master’s alone', async () => {
    const headers = as(crypto.randomUUID(), crypto.randomUUID(), 'reseller');

    const read = await app.inject({
      method: 'GET',
      url: '/v1/platform/security-settings',
      headers,
    });
    const write = await put(headers, { requireMasterMfa: true });

    expect(read.statusCode).toBe(403);
    expect(write.statusCode).toBe(403);
    expect((await h.securitySettings.get()).requireMasterMfa).toBe(false);
  });

  it('turns on without a code, even for an administrator who has not enrolled', async () => {
    const res = await put(as(crypto.randomUUID(), crypto.randomUUID()), { requireMasterMfa: true });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ requireMasterMfa: true });
    expect((await h.securitySettings.get()).requireMasterMfa).toBe(true);
  });

  it('turning it off asks for the administrator’s own code', async () => {
    const { orgId, user } = await enrolledMaster();

    const res = await put(as(orgId, user.id), { requireMasterMfa: false });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'step_up_required' });
    expect((await h.securitySettings.get()).requireMasterMfa).toBe(true);
  });

  it('turns off with a right code', async () => {
    const { orgId, user, totp } = await enrolledMaster();

    const res = await put(as(orgId, user.id), {
      requireMasterMfa: false,
      stepUpCode: codeFor(totp),
    });

    expect(res.statusCode).toBe(200);
    expect((await h.securitySettings.get()).requireMasterMfa).toBe(false);
  });

  it('saving what is already set changes nothing and needs no code', async () => {
    const res = await put(as(crypto.randomUUID(), crypto.randomUUID()), {
      requireMasterMfa: false,
    });

    expect(res.statusCode).toBe(200);
    expect((await h.securitySettings.get()).updatedAt).toBeNull();
  });
});
