import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  databaseOrSkipReason,
  natsOrSkipReason,
  redisOrSkipReason,
  s3OrSkipReason,
} from '@cuc/testing';

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
 * Everything a browser would call goes through the gateway (G-60), with a
 * real access token. What it covers: master and reseller sign-in with
 * authenticator enrollment, the reseller and its brand and hostname, a tenant
 * and its admin, the re-theme lookup, branded email, the tenant's PBX
 * configuration (emergency location, extension, ring group, media, voicemail
 * mailbox, schedule, trunk, DID), a call flow built, validated, published and
 * rolled back the way the builder writes one and pointed at by the DID, and
 * the CDR routes including the wall that keeps a reseller out of them.
 *
 * What it cannot cover here, and says so with `todo`: see the end.
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
  // The tenant's PBX configuration, made in the steps below and used by the flow.
  let locationId = '';
  let extensionId = '';
  let ringGroupId = '';
  let mediaId = '';
  let mailboxId = '';
  let trunkId = '';
  let didId = '';

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

  it('1. the master, made by bootstrap, has the master admin role: the console shows it something', async () => {
    const me = await master.call<{ roleIds: string[]; permissions: string[] }>(
      'GET',
      `/v1/orgs/${stack.masterOrgId}/me`,
    );
    expect(me.status).toBe(200);
    expect(me.json.roleIds).toEqual(['master_admin']);
    expect(me.json.permissions).toContain('reseller.manage');
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
    const me = await reseller.call<{ roleIds: string[]; permissions: string[] }>(
      'GET',
      `/v1/orgs/${resellerId}/me`,
    );
    expect(me.json.roleIds).toEqual(['reseller_admin']);
    expect(me.json.permissions).toContain('tenant.create');

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

  it('2. the master resets the reseller admin’s two-step verification: signed out, emailed, and asked to enroll again', async () => {
    const people = await master.call<{ rows: { id: string; email: string }[] }>(
      'GET',
      `/v1/orgs/${resellerId}/users`,
    );
    expect(people.status, people.text).toBe(200);
    const boss = people.json.rows.find((u) => u.email === 'boss@acme.test');
    expect(boss).toBeDefined();
    const oldSecret = secrets.get('boss@acme.test') ?? '';
    expect(oldSecret).not.toBe('');

    const done = await master.call<{ mfaEnrolled: boolean }>(
      'POST',
      `/v1/orgs/${resellerId}/users/${boss?.id ?? ''}/mfa-reset`,
      {},
    );
    expect(done.status, done.text).toBe(200);
    expect(done.json.mfaEnrolled).toBe(false);

    // Their session ends: the refresh cookie no longer works.
    const stale = await reseller.call('POST', '/v1/auth/refresh', {}, { auth: false });
    expect(stale.status).toBe(401);

    // They are told, in their reseller's brand, with a link to sign in and no token.
    const [mail] = await mailTo(stack.mail, 'boss@acme.test');
    expect(mail).toBeDefined();
    expect(mail?.HTML).toContain('Acme Voice');
    expect(mail?.HTML).toContain('/login');
    expect(mail?.HTML).not.toContain('token=');
    expect(mail?.From.Name).toBe('Acme Voice');

    // The next sign-in enrolls a new authenticator, and a new secret is issued.
    reseller.jar.clear();
    await signIn(reseller, resellerId, 'boss@acme.test', resellerPassword, secrets);
    expect(secrets.get('boss@acme.test')).not.toBe(oldSecret);

    // Nobody resets their own.
    const self = await reseller.call(
      'POST',
      `/v1/orgs/${resellerId}/users/${boss?.id ?? ''}/mfa-reset`,
      {},
    );
    expect(self.status).toBe(409);
  });

  /** Calls one of the tenant's routes through the gateway as its admin. */
  function tenant<T = Record<string, unknown>>(method: string, path: string, body?: unknown) {
    return tenantAdmin.call<T>(method, `/v1/tenants/${tenantId}${path}`, body);
  }

  // ---- the tenant's PBX configuration, through the gateway ---------------

  it('3. the tenant admin configures the PBX through the gateway: location, extension, ring group', async () => {
    const location = await tenant<{ id: string }>('POST', '/emergency-locations', {
      label: 'Head office',
      addressLine1: '1 Main St',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      country: 'US',
    });
    expect(location.status).toBe(201);
    locationId = location.json.id;

    const extension = await tenant<{ id: string; number: string }>('POST', '/extensions', {
      number: '101',
      displayName: 'Front desk',
      emergencyLocationId: locationId,
    });
    expect(extension.status).toBe(201);
    extensionId = extension.json.id;

    const listed = await tenant<{ rows: { id: string }[] }>('GET', '/extensions');
    expect(listed.json.rows.map((r) => r.id)).toContain(extensionId);

    const group = await tenant<{ id: string }>('POST', '/ring-groups', {
      label: 'Reception',
      strategy: 'simultaneous',
      memberExtensionIds: [extensionId],
      ringTimeoutSeconds: 20,
    });
    expect(group.status).toBe(201);
    ringGroupId = group.json.id;
  });

  it('3. a prompt, a voicemail mailbox, and opening hours', async () => {
    const media = await tenant<{ asset: { id: string } }>('POST', '/media-assets', {
      kind: 'prompt',
      label: 'Greeting',
      contentType: 'audio/wav',
    });
    expect(media.status).toBe(201);
    mediaId = media.json.asset.id;

    const mailbox = await tenant<{ id: string }>('POST', '/voicemail/mailboxes', {
      extensionId,
      pin: '2468',
    });
    expect(mailbox.status).toBe(201);
    mailboxId = mailbox.json.id;
    const mailboxes = await tenant<{ rows: { id: string }[] }>('GET', '/voicemail/mailboxes');
    expect(mailboxes.json.rows.map((r) => r.id)).toContain(mailboxId);

    const schedule = await tenant('POST', '/schedules', {
      label: 'Office hours',
      timezone: 'America/Chicago',
      rules: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }],
    });
    expect(schedule.status).toBe(201);
  });

  it('3. the reseller, acting for the tenant, adds a trunk, and the tenant points a number at the extension', async () => {
    const trunk = await reseller.call<{ id: string }>('POST', `/v1/tenants/${tenantId}/trunks`, {
      name: 'Carrier',
      authMode: 'register',
      host: 'sip.carrier.test',
      port: 5060,
      transport: 'udp',
      username: 'acme',
      secret: 'a carrier secret',
      codecs: ['PCMU', 'PCMA'],
    });
    expect(trunk.status).toBe(201);
    trunkId = trunk.json.id;
    // The secret is never handed back.
    expect(trunk.text).not.toContain('a carrier secret');

    const did = await tenant<{ id: string }>('POST', '/dids', {
      e164: '+12175550101',
      trunkId,
      destinationType: 'extension',
      destinationId: extensionId,
    });
    expect(did.status).toBe(201);
    didId = did.json.id;
  });

  // A flow shaped as the builder saves it: layout beside each node.
  const buildGraph = () => ({
    entryPoints: { main: 'menu' },
    nodes: [
      {
        id: 'menu',
        type: 'menu',
        config: { promptMediaAssetId: mediaId, timeoutSeconds: 5, maxInvalidAttempts: 3 },
        position: { x: 60, y: 60 },
        openPorts: ['1', '2'],
      },
      {
        id: 'desk',
        type: 'ring_group',
        config: { ringGroupId },
        position: { x: 380, y: 0 },
      },
      {
        id: 'mail',
        type: 'voicemail',
        config: { mailboxId },
        position: { x: 380, y: 200 },
      },
      { id: 'bye', type: 'hangup', config: {}, position: { x: 700, y: 60 } },
    ],
    edges: [
      { from: 'menu', port: '1', to: 'desk' },
      { from: 'menu', port: '2', to: 'mail' },
      { from: 'menu', port: 'timeout', to: 'bye' },
      { from: 'menu', port: 'invalid', to: 'bye' },
      { from: 'desk', port: 'noAnswer', to: 'mail' },
      { from: 'mail', port: 'next', to: 'bye' },
    ],
  });
  type Graph = ReturnType<typeof buildGraph>;
  it('4. the tenant builds a call flow: draft, validate, publish, and the runner-facing IR', async () => {
    const created = await tenant<{ id: string }>('POST', '/flows', { name: 'Main menu' });
    expect(created.status).toBe(201);
    flowId = created.json.id;

    const empty = await tenant<{ valid: boolean }>('POST', `/flows/${flowId}/validate`, {});
    expect(empty.json.valid).toBe(false);

    const saved = await tenant('PUT', `/flows/${flowId}/draft`, buildGraph());
    expect(saved.status).toBe(200);
    const valid = await tenant<{ valid: boolean; issues: unknown[] }>(
      'POST',
      `/flows/${flowId}/validate`,
      {},
    );
    expect(valid.json).toEqual({ valid: true, issues: [] });

    const published = await tenant<{ versionNumber: number }>(
      'POST',
      `/flows/${flowId}/publish`,
      {},
    );
    expect(published.status, JSON.stringify(published.json)).toBe(201);
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
    const v1 = await tenant<{ graph: Graph }>('GET', `/flows/${flowId}/versions/1`);
    expect(v1.json.graph.nodes[0]).toMatchObject({
      position: { x: 60, y: 60 },
      openPorts: ['1', '2'],
    });

    const original = buildGraph();
    const changed = {
      ...original,
      nodes: original.nodes.map((n) =>
        n.id === 'menu' ? { ...n, config: { ...(n.config as object), timeoutSeconds: 8 } } : n,
      ),
    };
    await tenant('PUT', `/flows/${flowId}/draft`, changed);
    const v2 = await tenant<{ versionNumber: number }>('POST', `/flows/${flowId}/publish`, {});
    expect(v2.json.versionNumber).toBe(2);
    const back = await tenant('POST', `/flows/${flowId}/rollback`, { versionNumber: 1 });
    expect(back.status).toBe(200);
    const versions = await tenant<{ rows: { versionNumber: number }[] }>(
      'GET',
      `/flows/${flowId}/versions`,
    );
    expect(versions.json.rows.map((v) => v.versionNumber)).toEqual([1, 2]);
  });

  it('4. an invalid flow is refused at publish, with every problem', async () => {
    const created = await tenant<{ id: string }>('POST', '/flows', { name: 'Broken' });
    await tenant('PUT', `/flows/${created.json.id}/draft`, {
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
    const r = await tenant('POST', `/flows/${created.json.id}/publish`, {});
    expect(r.status).toBe(422);
  });

  it('4. the number is pointed at the published flow, and the extension it replaced can be listed', async () => {
    const updated = await tenant<{ destinationType: string; destinationId: string }>(
      'PATCH',
      `/dids/${didId}`,
      { destinationType: 'flow', destinationId: flowId },
    );
    expect(updated.status).toBe(200);
    expect(updated.json).toMatchObject({ destinationType: 'flow', destinationId: flowId });

    const flows = await tenant<{
      rows: { id: string; currentPublishedVersionId: string | null }[];
    }>('GET', '/flows');
    const ours = flows.json.rows.find((f) => f.id === flowId);
    expect(ours?.currentPublishedVersionId).toBeTruthy();
  });

  it('6. call records: the tenant reads them and can start an export; the reseller is walled out', async () => {
    const cdrs = await tenant<{ rows: unknown[] }>('GET', '/cdrs');
    expect(cdrs.status).toBe(200);
    expect(cdrs.json.rows).toEqual([]);

    const now = new Date();
    const exported = await tenant<{ id: string; status: string }>('POST', '/cdr-exports', {
      from: new Date(now.getTime() - 86_400_000).toISOString(),
      to: now.toISOString(),
    });
    expect(exported.status).toBe(201);
    const one = await tenant<{ id: string }>('GET', `/cdr-exports/${exported.json.id}`);
    expect(one.json.id).toBe(exported.json.id);

    // H1 through the gateway: a reseller never reads a tenant's call records.
    const walled = await reseller.call('GET', `/v1/tenants/${tenantId}/cdrs`);
    expect(walled.status).toBe(403);
    expect(walled.json).toMatchObject({ code: 'reseller_private_data_denied' });
  });

  it('6. recordings: the tenant admin manages rules and retention and reads an empty list; the reseller is walled out', async () => {
    // recording-service asks identity-service what this admin may do, per request.
    const recordings = await tenant<{ rows: unknown[] }>('GET', '/recordings');
    expect(recordings.status, recordings.text).toBe(200);
    expect(recordings.json.rows).toEqual([]);

    const rule = await tenant<{ id: string }>('POST', '/recording-policies', {
      scopeType: 'tenant',
      action: 'record',
      announce: true,
    });
    expect(rule.status, rule.text).toBe(201);
    const rules = await tenant<{ rows: { id: string }[] }>('GET', '/recording-policies');
    expect(rules.json.rows.map((r) => r.id)).toEqual([rule.json.id]);
    const duplicate = await tenant('POST', '/recording-policies', {
      scopeType: 'tenant',
      action: 'no_record',
    });
    expect(duplicate.status).toBe(409);

    const settings = await tenant<{ retentionDays: number }>('PUT', '/recording-settings', {
      retentionDays: 30,
    });
    expect(settings.status, settings.text).toBe(200);
    expect((await tenant<{ retentionDays: number }>('GET', '/recording-settings')).json).toEqual({
      retentionDays: 30,
    });

    // H1 through the gateway: a reseller never reads a tenant's recordings, and holds no
    // permission over its recording rules either.
    const walled = await reseller.call('GET', `/v1/tenants/${tenantId}/recordings`);
    expect(walled.status).toBe(403);
    expect(walled.json).toMatchObject({ code: 'reseller_private_data_denied' });
    const noRules = await reseller.call('GET', `/v1/tenants/${tenantId}/recording-policies`);
    expect(noRules.status).toBe(403);
  });

  it('1. logging out ends the cookie session', async () => {
    const r = await master.call('POST', '/v1/auth/logout', {}, { auth: false });
    expect(r.status).toBe(204);
    expect(master.jar.has('refresh')).toBe(false);
  });

  // ---- what this journey cannot walk yet ---------------------------------

  // Step 5, the SIPp carrier call through a published flow into voicemail, is
  // tests/sip/test/call_flow.test.ts: it needs the FreeSWITCH and OpenSIPs
  // compose stack, which this suite does not start.
  // Step 6 is walked above against an empty list; the live call's own CDR is
  // asserted in that same tests/sip test.
});
