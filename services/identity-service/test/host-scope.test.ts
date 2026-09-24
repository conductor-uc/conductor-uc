import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, silentLogger } from '@cuc/testing';
import { createServer, type Server } from '@cuc/http';

import { OrgClientError, type OrgClient, type SignInScope } from '../src/org-client.js';
import { registerAuthRoutes } from '../src/routes/auth.routes.js';
import { startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();
const PASSWORD = 'correct horse battery staple';
const OTHER_PASSWORD = 'a completely different passphrase';

const MASTER = crypto.randomUUID();
const ACME = crypto.randomUUID();
const OTHER_RESELLER = crypto.randomUUID();
const ACME_TENANT_A = crypto.randomUUID();
const ACME_TENANT_B = crypto.randomUUID();
const OTHER_TENANT = crypto.randomUUID();

const HOSTS = new Map<string, SignInScope>([
  ['console.platform.test', { orgId: MASTER, type: 'master' }],
  ['portal.acme.example', { orgId: ACME, type: 'reseller' }],
  ['portal.other.example', { orgId: OTHER_RESELLER, type: 'reseller' }],
]);

/** What org-service answers, without a network. */
const orgClient: OrgClient = {
  lineage() {
    return Promise.resolve(undefined);
  },
  signInScope(host) {
    if (host === 'org-service-down.example') {
      return Promise.reject(new OrgClientError('down'));
    }
    return Promise.resolve(HOSTS.get(host));
  },
};

function orgOf(accessToken: string): string {
  const payload = accessToken.split('.')[1] ?? '';
  return (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { org: string }).org;
}

describe.skipIf(skipReason !== undefined)('org resolved from the console hostname (G-56)', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({ serviceName: 'identity-service', logger: silentLogger() });
    registerAuthRoutes(app, h.auth, { cookieSecure: true, orgClient });
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
      'users',
      'outbox',
    ] as const) {
      await h.db.kysely.deleteFrom(table).execute();
    }
  });

  function make(
    orgId: string,
    orgType: 'master' | 'reseller' | 'tenant',
    resellerId: string | null,
    email = 'sam@example.com',
    password = PASSWORD,
  ) {
    return h.users.create(
      { requestId: 'test' },
      { orgId, orgType, resellerId, email, displayName: 'Sam', password },
    );
  }

  function login(
    host: string | undefined,
    body: { orgId?: string; email?: string; password?: string },
    headers: Record<string, string> = {},
  ) {
    return app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { ...(host === undefined ? {} : { host }), ...headers },
      payload: { email: 'sam@example.com', password: PASSWORD, ...body },
    });
  }

  function reset(host: string | undefined, body: { orgId?: string; email?: string }) {
    return app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset',
      headers: host === undefined ? {} : { host },
      payload: { email: 'sam@example.com', ...body },
    });
  }

  async function resetEvents() {
    const rows = await h.db.kysely.selectFrom('outbox').selectAll().execute();
    return rows.filter((r) => r.type === 'identity.user.password_reset_requested');
  }

  describe('sign in', () => {
    it("a tenant user signs in at their reseller's console with no org id", async () => {
      await make(ACME_TENANT_A, 'tenant', ACME);
      const response = await login('portal.acme.example', {});
      expect(response.statusCode).toBe(200);
      expect(orgOf(response.json<{ accessToken: string }>().accessToken)).toBe(ACME_TENANT_A);
    });

    it("the reseller's own user signs in there too, and is asked for a second factor", async () => {
      await make(ACME, 'reseller', null);
      const response = await login('portal.acme.example', {});
      expect(response.json()).toMatchObject({ status: 'mfa_enrollment_required' });
    });

    it('the master console reaches only the master, not tenants or resellers', async () => {
      await make(MASTER, 'master', null);
      expect((await login('console.platform.test', {})).json()).toMatchObject({
        status: 'mfa_enrollment_required',
      });
      await h.db.kysely.deleteFrom('mfa_factors').execute();
      await h.db.kysely.deleteFrom('users').execute();
      await make(ACME_TENANT_A, 'tenant', ACME);
      expect((await login('console.platform.test', {})).statusCode).toBe(401);
    });

    it("another reseller's user cannot sign in at this console", async () => {
      await make(OTHER_TENANT, 'tenant', OTHER_RESELLER);
      expect((await login('portal.acme.example', {})).statusCode).toBe(401);
    });

    it('a wrong password and an unknown address look the same', async () => {
      await make(ACME_TENANT_A, 'tenant', ACME);
      const wrong = await login('portal.acme.example', { password: 'nope nope nope nope' });
      const unknown = await login('portal.acme.example', { email: 'nobody@example.com' });
      expect(wrong.statusCode).toBe(401);
      expect(unknown.statusCode).toBe(401);
      const strip = (body: object) => ({ ...body, requestId: undefined });
      expect(strip(wrong.json())).toEqual(strip(unknown.json()));
    });

    it('an address in two tenants is told apart by its password', async () => {
      await make(ACME_TENANT_A, 'tenant', ACME, 'sam@example.com', PASSWORD);
      await make(ACME_TENANT_B, 'tenant', ACME, 'sam@example.com', OTHER_PASSWORD);
      const a = await login('portal.acme.example', { password: PASSWORD });
      const b = await login('portal.acme.example', { password: OTHER_PASSWORD });
      expect(orgOf(a.json<{ accessToken: string }>().accessToken)).toBe(ACME_TENANT_A);
      expect(orgOf(b.json<{ accessToken: string }>().accessToken)).toBe(ACME_TENANT_B);
    });

    it('an address and password in two tenants asks for the org, and then works', async () => {
      await make(ACME_TENANT_A, 'tenant', ACME);
      await make(ACME_TENANT_B, 'tenant', ACME);
      const ambiguous = await login('portal.acme.example', {});
      expect(ambiguous.statusCode).toBe(409);
      expect(ambiguous.json()).toMatchObject({ code: 'org_required' });
      const named = await login('portal.acme.example', { orgId: ACME_TENANT_B });
      expect(orgOf(named.json<{ accessToken: string }>().accessToken)).toBe(ACME_TENANT_B);
    });

    it('a wrong password never reaches the ambiguity question', async () => {
      await make(ACME_TENANT_A, 'tenant', ACME);
      await make(ACME_TENANT_B, 'tenant', ACME);
      const response = await login('portal.acme.example', { password: 'nope nope nope nope' });
      expect(response.statusCode).toBe(401);
    });

    it('a hostname nobody owns and no org id is a 400 that names nothing', async () => {
      await make(ACME_TENANT_A, 'tenant', ACME);
      const response = await login('unknown.example', {});
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'org_required' });
      expect(JSON.stringify(response.json())).not.toContain(ACME);
      expect((await login(undefined, {})).statusCode).toBe(400);
    });

    it('an explicit org id still works, on any hostname', async () => {
      await make(ACME_TENANT_A, 'tenant', ACME);
      expect((await login('unknown.example', { orgId: ACME_TENANT_A })).statusCode).toBe(200);
      expect((await login('portal.other.example', { orgId: ACME_TENANT_A })).statusCode).toBe(200);
    });

    it('takes the hostname from x-forwarded-host, ignoring the port and the case', async () => {
      await make(ACME_TENANT_A, 'tenant', ACME);
      const response = await login(
        'gateway.internal:8080',
        {},
        { 'x-forwarded-host': 'Portal.Acme.Example:8443' },
      );
      expect(response.statusCode).toBe(200);
    });

    it('is a 503, not a guess, when org-service cannot be reached', async () => {
      const response = await login('org-service-down.example', {});
      expect(response.statusCode).toBe(503);
    });
  });

  describe('password reset', () => {
    it('finds the account from the hostname, with no org id', async () => {
      await make(ACME_TENANT_A, 'tenant', ACME);
      expect((await reset('portal.acme.example', {})).statusCode).toBe(202);
      expect(await resetEvents()).toHaveLength(1);
    });

    it('an address in two tenants gets a link for each, naming its own org', async () => {
      await make(ACME_TENANT_A, 'tenant', ACME);
      await make(ACME_TENANT_B, 'tenant', ACME);
      expect((await reset('portal.acme.example', {})).statusCode).toBe(202);
      const events = await resetEvents();
      expect(events).toHaveLength(2);
      const orgs = events.map(
        (e) =>
          (
            (typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload) as {
              orgId: string;
            }
          ).orgId,
      );
      expect(new Set(orgs)).toEqual(new Set([ACME_TENANT_A, ACME_TENANT_B]));
    });

    it('answers 202 and does nothing for an unknown address or another reseller', async () => {
      await make(OTHER_TENANT, 'tenant', OTHER_RESELLER);
      const unknown = await reset('portal.acme.example', { email: 'nobody@example.com' });
      expect(unknown.statusCode).toBe(202);
      expect((await reset('portal.acme.example', {})).statusCode).toBe(202);
      expect(await resetEvents()).toHaveLength(0);
    });

    it('an unowned hostname with no org id is a 400', async () => {
      const response = await reset('unknown.example', {});
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'org_required' });
    });
  });
});
