import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  databaseOrSkipReason,
  natsOrSkipReason,
  redisOrSkipReason,
  s3OrSkipReason,
} from '@cuc/testing';
import { signInternalHeaders } from '@cuc/http';

import { Browser, mailTo, tokenIn, totp } from '../src/browser.js';
import {
  MAILPIT_URL,
  MASTER_EMAIL,
  MASTER_PASSWORD,
  startStack,
  type Stack,
} from '../src/stack.js';

/**
 * The pilot journey (plan S3-11), as far as the services in this repo allow,
 * driven over HTTP with real processes on real infrastructure. The console's
 * own walk through the same journey is `apps/console/test/journey_test.dart`.
 *
 * What it covers: master and reseller sign-in with authenticator enrollment,
 * the reseller and its brand and hostname, a tenant and its admin, the
 * re-theme lookup, branded email, and building, validating, publishing and
 * rolling back a call flow the way the builder writes one.
 *
 * What it cannot cover yet, and says so with `todo`: see the end.
 */
async function infraSkipReason(): Promise<string | undefined> {
  const missing =
    (await databaseOrSkipReason()) ??
    (await natsOrSkipReason()) ??
    (await redisOrSkipReason()) ??
    (await s3OrSkipReason());
  if (missing !== undefined) return missing;
  try {
    const response = await fetch(`${MAILPIT_URL}/api/v1/info`, {
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) return undefined;
    return `Mailpit answered ${String(response.status)}`;
  } catch {
    if (process.env['REQUIRE_SMTP_TESTS'] === '1') {
      throw new Error(`Mailpit is not reachable at ${MAILPIT_URL}, and REQUIRE_SMTP_TESTS=1.`);
    }
    return `Mailpit is not reachable at ${MAILPIT_URL}`;
  }
}

const skipReason = await infraSkipReason();

interface Tokens {
  status: string;
  accessToken?: string;
  enrollmentTicket?: string;
  verificationTicket?: string;
  totp?: { secret: string };
}

describe.skipIf(skipReason !== undefined)('M2 pilot journey', () => {
  let stack: Stack;
  let master: Browser;
  let reseller: Browser;
  let tenantAdmin: Browser;
  let resellerId = '';
  let tenantId = '';
  let flowId = '';

  const resellerPassword = 'an acme boss passphrase';
  const tenantPassword = 'a dental admin passphrase';

  beforeAll(async () => {
    stack = await startStack();
    // Mailpit is shared; start from an empty mailbox.
    await fetch(`${stack.mail}/api/v1/messages`, { method: 'DELETE' });
    master = new Browser(stack.gateway);
    reseller = new Browser(stack.gateway);
    tenantAdmin = new Browser(stack.gateway);
  });

  afterAll(async () => {
    await stack?.stop();
  });

  /** Signs in the way the console does: password, then enroll or verify a code. */
  async function signIn(
    who: Browser,
    orgId: string,
    email: string,
    password: string,
    secrets: Map<string, string>,
  ): Promise<void> {
    let r = await who.call<Tokens>(
      'POST',
      '/v1/auth/login',
      { orgId, email, password },
      { auth: false },
    );
    expect(r.status).toBe(200);
    if (r.json.status === 'mfa_enrollment_required') {
      const secret = r.json.totp?.secret ?? '';
      secrets.set(email, secret);
      r = await who.call<Tokens>(
        'POST',
        '/v1/auth/mfa/enroll/confirm',
        { enrollmentTicket: r.json.enrollmentTicket, code: totp(secret) },
        { auth: false },
      );
    } else if (r.json.status === 'mfa_verification_required') {
      r = await who.call<Tokens>(
        'POST',
        '/v1/auth/mfa/verify',
        { verificationTicket: r.json.verificationTicket, code: totp(secrets.get(email) ?? '') },
        { auth: false },
      );
    }
    expect(r.status).toBe(200);
    expect(r.json.accessToken).toBeTruthy();
    who.access = r.json.accessToken;
  }
  const secrets = new Map<string, string>();

  it('1. the master signs in, enrolling an authenticator, with the refresh token in a cookie only', async () => {
    await signIn(master, stack.masterOrgId, MASTER_EMAIL, MASTER_PASSWORD, secrets);
    expect(master.jar.has('refresh')).toBe(true);
    const restored = new Browser(stack.gateway);
    for (const [k, v] of master.jar) restored.jar.set(k, v);
    const r = await restored.call<Tokens>('POST', '/v1/auth/refresh', {}, { auth: false });
    expect(r.status).toBe(200);
    expect(r.json.accessToken).toBeTruthy();
    expect((r.json as unknown as Record<string, unknown>)['refreshToken']).toBeUndefined();
    // Reuse of the old cookie is refused; sign in again for the rest.
    const replay = await master.call('POST', '/v1/auth/refresh', {}, { auth: false });
    expect(replay.status).toBe(401);
    master.jar.clear();
    await signIn(master, stack.masterOrgId, MASTER_EMAIL, MASTER_PASSWORD, secrets);
  });

  it('1. the master creates a reseller', async () => {
    const r = await master.call<{ id: string }>('POST', '/v1/resellers', {
      slug: 'acme',
      name: 'Acme Voice Ltd',
      adminEmail: 'boss@acme.test',
      adminDisplayName: 'Acme Boss',
      adminPassword: resellerPassword,
    });
    expect(r.status).toBe(201);
    resellerId = r.json.id;
  });

  it('2. the reseller signs in, brands the console, registers its hostname, and the public brand follows', async () => {
    await signIn(reseller, resellerId, 'boss@acme.test', resellerPassword, secrets);

    const weak = await reseller.call('PUT', `/v1/resellers/${resellerId}/brand`, {
      primaryColor: '#4a148c',
      accentColor: '#5e35b1',
    });
    expect(weak.status).toBe(400);
    expect(weak.text).toMatch(/4\.5/);

    const brand = await reseller.call('PUT', `/v1/resellers/${resellerId}/brand`, {
      displayName: 'Acme Voice',
      primaryColor: '#4a148c',
      accentColor: '#ffe082',
      emailFromName: 'Acme Voice',
      legalFooter: 'Acme Voice Ltd.',
    });
    expect(brand.status).toBe(200);
    const host = await reseller.call('POST', `/v1/resellers/${resellerId}/console-hostnames`, {
      fqdn: 'portal.acme.test',
    });
    expect(host.status).toBe(201);

    const visitor = new Browser(stack.gateway);
    const branded = await visitor.call<{
      neutral: boolean;
      displayName?: string;
      primaryColor?: string;
    }>('GET', '/v1/public/brand?host=portal.acme.test', undefined, { auth: false });
    expect(branded.json).toMatchObject({
      neutral: false,
      displayName: 'Acme Voice',
      primaryColor: '#4a148c',
    });
    const neutral = await visitor.call('GET', '/v1/public/brand?host=unknown.example', undefined, {
      auth: false,
    });
    expect(neutral.json).toEqual({ neutral: true });
  });

  it('2. the reseller creates a tenant; its admin signs in without a second factor', async () => {
    const r = await reseller.call<{ id: string }>('POST', `/v1/resellers/${resellerId}/tenants`, {
      slug: 'dental',
      name: 'Bright Dental',
      adminEmail: 'admin@dental.test',
      adminDisplayName: 'Dental Admin',
      adminPassword: tenantPassword,
    });
    expect(r.status).toBe(201);
    tenantId = r.json.id;

    const login = await tenantAdmin.call<Tokens>(
      'POST',
      '/v1/auth/login',
      { orgId: tenantId, email: 'admin@dental.test', password: tenantPassword },
      { auth: false },
    );
    expect(login.json.status).not.toBe('mfa_enrollment_required');
    expect(login.json.accessToken).toBeTruthy();
    tenantAdmin.access = login.json.accessToken;
  });

  it('2. after sign-in the console re-themes: the tenant is shown its reseller brand, the master none', async () => {
    const asTenant = await tenantAdmin.call('GET', '/v1/session/brand');
    expect(asTenant.status).toBe(200);
    expect(asTenant.json).toMatchObject({ neutral: false, displayName: 'Acme Voice' });
    const asMaster = await master.call('GET', '/v1/session/brand');
    expect(asMaster.json).toEqual({ neutral: true });
  });

  it("2. the tenant's password-reset email carries its reseller's brand, and the link works once", async () => {
    const visitor = new Browser(stack.gateway);
    const asked = await visitor.call(
      'POST',
      '/v1/auth/password-reset',
      { orgId: tenantId, email: 'admin@dental.test' },
      { auth: false },
    );
    expect(asked.status).toBe(202);
    const [mail] = await mailTo(stack.mail, 'admin@dental.test');
    expect(mail).toBeDefined();
    expect(mail?.HTML).toContain('Acme Voice');
    expect(mail?.From.Name).toBe('Acme Voice');
    const token = mail === undefined ? undefined : tokenIn(mail, '/reset/confirm');
    expect(token).toBeTruthy();
    const done = await visitor.call(
      'POST',
      '/v1/auth/password-reset/confirm',
      { token, newPassword: 'a fresh dental passphrase' },
      { auth: false },
    );
    expect(done.status, done.text).toBe(204);
    const again = await visitor.call(
      'POST',
      '/v1/auth/password-reset/confirm',
      { token, newPassword: 'and another passphrase' },
      { auth: false },
    );
    expect(again.status).toBe(400);
  });

  it('2. the master invites a colleague and the email carries no brand, name or logo', async () => {
    const r = await master.call('POST', `/v1/orgs/${stack.masterOrgId}/invitations`, {
      email: 'newhire@platform.test',
      displayName: 'New Hire',
    });
    expect(r.status, r.text).toBe(201);
    const [mail] = await mailTo(stack.mail, 'newhire@platform.test');
    expect(mail).toBeDefined();
    expect(mail?.HTML).not.toMatch(/Acme/);
    expect(mail?.From.Name).toBe('');
    expect(mail?.HTML).not.toMatch(/<img/i);
    expect(`${mail?.HTML ?? ''}${mail?.Text ?? ''}`).not.toMatch(/conductor/i);
  });

  /** Calls callflow-service the way the gateway would once it routes there. */
  async function callflow<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: T }> {
    const response = await fetch(`${stack.callflow}/v1/tenants/${tenantId}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...signInternalHeaders(stack.headerSecret, {
          actorId: 'dental-admin',
          actorType: 'user',
          orgId: tenantId,
          orgType: 'tenant',
          tenantId,
        }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, json: (text === '' ? null : JSON.parse(text)) as T };
  }

  // A flow shaped as the builder saves it: layout beside each node.
  const graph = {
    entryPoints: { main: 'menu' },
    nodes: [
      {
        id: 'menu',
        type: 'menu',
        config: { promptMediaAssetId: 'greeting', timeoutSeconds: 5, maxInvalidAttempts: 3 },
        position: { x: 60, y: 60 },
        openPorts: ['1'],
      },
      {
        id: 'mail',
        type: 'voicemail',
        config: { mailboxId: 'mailbox-1' },
        position: { x: 380, y: 60 },
      },
      { id: 'bye', type: 'hangup', config: {}, position: { x: 700, y: 60 } },
    ],
    edges: [
      { from: 'menu', port: '1', to: 'mail' },
      { from: 'menu', port: 'timeout', to: 'bye' },
      { from: 'menu', port: 'invalid', to: 'bye' },
      { from: 'mail', port: 'next', to: 'bye' },
    ],
  };

  it('4. the tenant builds a call flow: draft, validate, publish, and the runner-facing IR', async () => {
    const created = await callflow<{ id: string }>('POST', '/flows', { name: 'Main menu' });
    expect(created.status).toBe(201);
    flowId = created.json.id;

    const empty = await callflow<{ valid: boolean }>('POST', `/flows/${flowId}/validate`, {});
    expect(empty.json.valid).toBe(false);

    const saved = await callflow('PUT', `/flows/${flowId}/draft`, graph);
    expect(saved.status).toBe(200);
    const valid = await callflow<{ valid: boolean; issues: unknown[] }>(
      'POST',
      `/flows/${flowId}/validate`,
      {},
    );
    expect(valid.json).toEqual({ valid: true, issues: [] });

    const published = await callflow<{ versionNumber: number }>(
      'POST',
      `/flows/${flowId}/publish`,
      {},
    );
    expect(published.status).toBe(201);
    expect(published.json.versionNumber).toBe(1);

    const irResponse = await fetch(
      `${stack.callflow}/internal/v1/tenants/${tenantId}/flows/${flowId}/ir`,
      { headers: { authorization: `Bearer ${stack.internalToken}` } },
    );
    expect(irResponse.status).toBe(200);
    const text = await irResponse.text();
    expect(text).toContain('"voicemail"');
    expect(text).not.toContain('position');
    expect(text).not.toContain('openPorts');
  });

  it('4. a published version keeps its graph and layout, can be replaced, and rolled back to', async () => {
    const v1 = await callflow<{ graph: typeof graph }>('GET', `/flows/${flowId}/versions/1`);
    expect(v1.json.graph.nodes[0]).toMatchObject({ position: { x: 60, y: 60 } });

    const changed = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === 'menu' ? { ...n, config: { ...(n.config as object), timeoutSeconds: 8 } } : n,
      ),
    };
    await callflow('PUT', `/flows/${flowId}/draft`, changed);
    const v2 = await callflow<{ versionNumber: number }>('POST', `/flows/${flowId}/publish`, {});
    expect(v2.json.versionNumber).toBe(2);
    const back = await callflow('POST', `/flows/${flowId}/rollback`, { versionNumber: 1 });
    expect(back.status).toBe(200);
    const versions = await callflow<{ rows: { versionNumber: number }[] }>(
      'GET',
      `/flows/${flowId}/versions`,
    );
    expect(versions.json.rows.map((v) => v.versionNumber)).toEqual([1, 2]);
  });

  it('4. an invalid flow is refused at publish, with every problem', async () => {
    const created = await callflow<{ id: string }>('POST', '/flows', { name: 'Broken' });
    await callflow('PUT', `/flows/${created.json.id}/draft`, {
      entryPoints: { main: 'm' },
      nodes: [
        {
          id: 'm',
          type: 'menu',
          config: { promptMediaAssetId: 'x', timeoutSeconds: 5, maxInvalidAttempts: 3 },
        },
      ],
      edges: [],
    });
    const r = await callflow('POST', `/flows/${created.json.id}/publish`, {});
    expect(r.status).toBe(422);
  });

  it('1. logging out ends the cookie session', async () => {
    const r = await master.call('POST', '/v1/auth/logout', {}, { auth: false });
    expect(r.status).toBe(204);
    expect(master.jar.has('refresh')).toBe(false);
  });

  // ---- what this journey cannot walk yet ---------------------------------

  it.todo(
    '3. the reseller adds a trunk: the gateway does not route to trunk-service or pbx-config-service (G-60)',
  );
  it.todo(
    '4. the tenant admin creates extensions and a DID through the gateway: same gap (G-60); the console screens for them cannot work through the gateway until it routes /v1/tenants/:id/<resource> by service',
  );
  it.todo(
    '5. a SIPp carrier call traverses the flow into voicemail: needs the FreeSWITCH and OpenSIPs compose stack (tests/sip), and a published flow reachable from a DID',
  );
  it.todo('6. a CDR is exported: cdr-service has no export route through the gateway (G-60)');
});
