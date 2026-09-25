import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { connectBus, type Bus, type EventConsumer } from '@cuc/events';
import {
  databaseOrSkipReason,
  natsOrSkipReason,
  silentLogger,
  startTestDatabase,
  startTestNats,
  type TestDatabaseHandle,
  type TestNatsHandle,
} from '@cuc/testing';

import { migrations } from '../migrations/index.js';
import { createIdentityConsumer } from '../src/consumers/identity.consumer.js';
import type { MailBrandResponse } from '../src/domain/brand.js';
import { notificationEvents } from '../src/events.js';
import { createIdentityClient, type OrgAdmin } from '../src/identity-client.js';
import { createMailer } from '../src/mailer.js';
import { createOrgClient } from '../src/org-client.js';
import type { NotificationServiceDb } from '../src/schema.js';
import { clearMailbox, emailsTo, mailpitOrSkipReason, SMTP_HOST, SMTP_PORT } from './mailpit.js';

const skipReason =
  (await databaseOrSkipReason()) ?? (await natsOrSkipReason()) ?? (await mailpitOrSkipReason());

const INTERNAL_TOKEN = 'test-internal-service-token';
const NOREPLY = 'noreply@platform.test';

const ACME: MailBrandResponse = {
  neutral: false,
  displayName: 'Acme Voice',
  primaryColor: '#4a148c',
  accentColor: '#ffe082',
  supportEmail: 'help@acme.example',
  supportUrl: null,
  supportPhone: null,
  emailFromName: 'Acme Voice',
  legalFooter: 'Acme Voice Ltd.',
  consoleHostname: 'portal.acme.example',
};
const GLOBEX: MailBrandResponse = {
  ...ACME,
  displayName: 'Globex Telecom',
  emailFromName: 'Globex Telecom',
  legalFooter: 'Globex Telecom Inc.',
  supportEmail: 'help@globex.example',
  consoleHostname: 'portal.globex.example',
};
const NEUTRAL: MailBrandResponse = {
  neutral: true,
  displayName: null,
  primaryColor: null,
  accentColor: null,
  supportEmail: null,
  supportUrl: null,
  supportPhone: null,
  emailFromName: null,
  legalFooter: null,
  consoleHostname: null,
};

describe.skipIf(skipReason !== undefined)('identity email consumer', () => {
  let handle: TestDatabaseHandle;
  let db: Database<NotificationServiceDb>;
  let nats: TestNatsHandle;
  let bus: Bus;
  let org: HttpServer;
  let orgUrl: string;
  /** What the fake org-service answers per org id; absent means 404. */
  const brands = new Map<string, MailBrandResponse>();
  let orgDown = false;
  /** What the fake identity-service answers for an org's admins; absent means none. */
  const admins = new Map<string, OrgAdmin[]>();
  let identityDown = false;
  let consumer: EventConsumer;

  function buildConsumer(smtpPort = SMTP_PORT): EventConsumer {
    return createIdentityConsumer(
      db,
      bus,
      silentLogger(),
      createOrgClient({ baseUrl: orgUrl, internalServiceToken: INTERNAL_TOKEN }),
      // The same fake server plays identity-service's internal admins route.
      createIdentityClient({ baseUrl: orgUrl, internalServiceToken: INTERNAL_TOKEN }),
      createMailer({ host: SMTP_HOST, port: smtpPort, secure: false, fromAddress: NOREPLY }),
      {
        pullTimeoutMs: 1000,
        defaultConsoleBase: 'https://console.platform.test',
        linkScheme: 'https',
      },
    );
  }

  beforeAll(async () => {
    const logger = silentLogger();
    handle = await startTestDatabase();
    db = createDatabase<NotificationServiceDb>({
      host: handle.host,
      port: handle.port,
      user: handle.user,
      password: handle.password,
      database: handle.database,
      logger,
    });
    await migrateToLatest({ db: db.kysely, migrations, logger });

    nats = await startTestNats();
    bus = await connectBus({ servers: [nats.server], logger, name: 'notification-test' });
    await bus.ensureStreams();

    org = createServer((request, response) => {
      const adminsOf = /^\/internal\/v1\/orgs\/([^/]+)\/admins$/.exec(request.url ?? '');
      if (adminsOf !== null) {
        if (identityDown) {
          response.writeHead(503).end();
          return;
        }
        if (request.headers.authorization !== `Bearer ${INTERNAL_TOKEN}`) {
          response.writeHead(401).end();
          return;
        }
        const rows = admins.get(decodeURIComponent(adminsOf[1]!)) ?? [];
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ rows }));
        return;
      }
      const match = /^\/internal\/v1\/orgs\/([^/]+)\/mail-brand$/.exec(request.url ?? '');
      if (orgDown) {
        response.writeHead(503).end();
        return;
      }
      if (request.headers.authorization !== `Bearer ${INTERNAL_TOKEN}` || match === null) {
        response.writeHead(401).end();
        return;
      }
      const brand = brands.get(decodeURIComponent(match[1]!));
      if (brand === undefined) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(brand));
    });
    await new Promise<void>((resolve) => org.listen(0, '127.0.0.1', resolve));
    orgUrl = `http://127.0.0.1:${String((org.address() as AddressInfo).port)}`;

    consumer = buildConsumer();
    await consumer.ensure();
  });

  afterAll(async () => {
    org?.close();
    await bus?.close();
    await nats?.stop();
    await db?.destroy();
    await handle?.stop();
  });

  beforeEach(async () => {
    brands.clear();
    orgDown = false;
    admins.clear();
    identityDown = false;
    await clearMailbox();
  });

  afterEach(async () => {
    await db.kysely.deleteFrom('sent_emails').execute();
    await db.kysely.deleteFrom('consumed_events').execute();
  });

  /** Runs the consumer until it has taken something, tolerating a slow first pull. */
  async function drain(target = consumer): Promise<{ handled: number; failed: number }> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const pass = await target.runOnce();
      if (pass.handled > 0 || pass.failed > 0) return pass;
    }
    return { handled: 0, failed: 0 };
  }

  const inOneHour = () => new Date(Date.now() + 60 * 60_000).toISOString();

  async function publishReset(
    orgId: string,
    email: string,
    token: string,
    opts: { id?: string; expiresAt?: string } = {},
  ): Promise<string> {
    const id = opts.id ?? crypto.randomUUID();
    await bus.publish({
      id,
      type: 'identity.user.password_reset_requested',
      schemaVersion: notificationEvents.contract('identity.user.password_reset_requested')
        .schemaVersion,
      occurredAt: new Date().toISOString(),
      orgContext: {},
      data: {
        userId: crypto.randomUUID(),
        orgId,
        email,
        token,
        expiresAt: opts.expiresAt ?? inOneHour(),
      },
    });
    return id;
  }

  async function publishInvitation(orgId: string, email: string, token: string): Promise<void> {
    await bus.publish({
      id: crypto.randomUUID(),
      type: 'identity.invitation.created',
      schemaVersion: notificationEvents.contract('identity.invitation.created').schemaVersion,
      occurredAt: new Date().toISOString(),
      orgContext: {},
      data: {
        invitationId: crypto.randomUUID(),
        orgId,
        orgType: 'tenant',
        resellerId: null,
        email,
        displayName: 'Sam Rivera',
        token,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
      },
    });
  }

  it("a reseller's user gets a reset email in that reseller's brand", async () => {
    brands.set('tenant-a', ACME);
    const to = `a-${crypto.randomUUID()}@example.test`;
    await publishReset('tenant-a', to, 'tok-A_1');
    await drain();

    const [mail] = await emailsTo(to);
    expect(mail).toBeDefined();
    expect(mail!.subject).toBe('Reset your password');
    expect(mail!.from).toEqual({ name: 'Acme Voice', address: NOREPLY });
    expect(mail!.html).toContain('Acme Voice');
    expect(mail!.html).toContain('Acme Voice Ltd.');
    expect(mail!.html).toContain('help@acme.example');
    expect(mail!.html).toContain('https://portal.acme.example/reset/confirm?token=tok-A_1');
    expect(mail!.text).toContain('https://portal.acme.example/reset/confirm?token=tok-A_1');
  });

  it('a master-tier user gets a neutral email: no brand, no display name, no logo', async () => {
    brands.set('master', NEUTRAL);
    const to = `m-${crypto.randomUUID()}@example.test`;
    await publishReset('master', to, 'tok-M');
    await drain();

    const [mail] = await emailsTo(to);
    expect(mail).toBeDefined();
    expect(mail!.from).toEqual({ name: '', address: NOREPLY });
    expect(mail!.html).not.toContain('Acme');
    expect(mail!.html).not.toMatch(/<img/i);
    // Neither the codebase name nor any operator name appears (rule 1, D-002).
    expect(mail!.html.toLowerCase()).not.toContain('conductor');
    expect(mail!.text.toLowerCase()).not.toContain('conductor');
    // Links go to the platform's own neutral console.
    expect(mail!.html).toContain('https://console.platform.test/reset/confirm?token=tok-M');
  });

  it("two resellers' users each get only their own brand", async () => {
    brands.set('tenant-a', ACME);
    brands.set('tenant-g', GLOBEX);
    const a = `a-${crypto.randomUUID()}@example.test`;
    const g = `g-${crypto.randomUUID()}@example.test`;
    await publishReset('tenant-a', a, 'tok-a');
    await publishReset('tenant-g', g, 'tok-g');
    await drain();
    await drain();

    const [mailA] = await emailsTo(a);
    const [mailG] = await emailsTo(g);
    expect(mailA!.html).toContain('Acme Voice');
    expect(mailA!.html).not.toContain('Globex');
    expect(mailA!.from.name).toBe('Acme Voice');
    expect(mailG!.html).toContain('Globex Telecom');
    expect(mailG!.html).not.toContain('Acme');
    expect(mailG!.from.name).toBe('Globex Telecom');
  });

  it('sends an invitation, greeting the person by name', async () => {
    brands.set('tenant-a', ACME);
    const to = `i-${crypto.randomUUID()}@example.test`;
    await publishInvitation('tenant-a', to, 'inv-tok');
    await drain();

    const [mail] = await emailsTo(to);
    expect(mail!.subject).toBe('You have been invited');
    expect(mail!.html).toContain('Hello Sam Rivera');
    expect(mail!.html).toContain('https://portal.acme.example/invite?token=inv-tok');
    expect(mail!.html).toContain('7 days');
  });

  async function publishMfaReset(
    orgId: string,
    email: string,
    opts: { userId?: string; actorId?: string } = {},
  ): Promise<string> {
    const id = crypto.randomUUID();
    await bus.publish({
      id,
      type: 'identity.user.mfa_reset',
      schemaVersion: notificationEvents.contract('identity.user.mfa_reset').schemaVersion,
      occurredAt: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString(),
      orgContext: {},
      actor: { type: 'user', id: opts.actorId ?? crypto.randomUUID(), orgId },
      data: {
        userId: opts.userId ?? crypto.randomUUID(),
        orgId,
        email,
        displayName: 'Rae Okafor',
      },
    });
    return id;
  }

  it("tells a reseller's user their two-step verification was reset, in the reseller's brand", async () => {
    brands.set('tenant-a', ACME);
    const to = `r-${crypto.randomUUID()}@example.test`;
    await publishMfaReset('tenant-a', to);
    await drain();

    const [mail] = await emailsTo(to);
    expect(mail).toBeDefined();
    expect(mail!.subject).toBe('Your two-step verification was reset');
    // The sender is still the platform address (G-57); the name is the reseller's.
    expect(mail!.from).toEqual({ name: 'Acme Voice', address: NOREPLY });
    expect(mail!.html).toContain('Hello Rae Okafor');
    expect(mail!.html).toContain('Acme Voice Ltd.');
    // It links to the sign-in page, and carries no token.
    expect(mail!.html).toContain('https://portal.acme.example/login');
    expect(mail!.html).not.toContain('token=');
    expect(mail!.text).toContain('https://portal.acme.example/login');
    expect(mail!.text).not.toContain('token=');
  });

  it('a master-tier user gets the same notice with no branding at all', async () => {
    brands.set('master', NEUTRAL);
    const to = `m-${crypto.randomUUID()}@example.test`;
    await publishMfaReset('master', to);
    await drain();

    const [mail] = await emailsTo(to);
    expect(mail).toBeDefined();
    expect(mail!.from).toEqual({ name: '', address: NOREPLY });
    expect(mail!.html).not.toMatch(/<img/i);
    expect(mail!.html.toLowerCase()).not.toContain('conductor');
    expect(mail!.text.toLowerCase()).not.toContain('conductor');
    expect(mail!.html).toContain('https://console.platform.test/login');
  });

  it('sends the notice however late it arrives (there is no link to go stale)', async () => {
    brands.set('tenant-a', ACME);
    const to = `late-${crypto.randomUUID()}@example.test`;
    // `publishMfaReset` stamps the event three days ago.
    await publishMfaReset('tenant-a', to);
    await drain();
    expect(await emailsTo(to)).toHaveLength(1);
  });

  describe("the org's other admins hear about a two-step reset too (G-100)", () => {
    function admin(label: string): OrgAdmin {
      return {
        userId: crypto.randomUUID(),
        email: `${label}-${crypto.randomUUID()}@example.test`,
        displayName: `Admin ${label}`,
      };
    }

    it('each other admin gets a notice in the brand: not the admin who did it, not the person', async () => {
      brands.set('tenant-a', ACME);
      const person = admin('rae');
      const actor = admin('boss');
      const ann = admin('ann');
      const bea = admin('bea');
      // The person is an admin too, so the list names them: they get only their own notice.
      admins.set('tenant-a', [ann, actor, bea, person]);
      const id = await publishMfaReset('tenant-a', person.email, {
        userId: person.userId,
        actorId: actor.userId,
      });
      await drain();

      for (const other of [ann, bea]) {
        const [mail] = await emailsTo(other.email);
        expect(mail).toBeDefined();
        expect(mail!.subject).toBe(
          'Two-step verification was reset for someone in your organization',
        );
        expect(mail!.from).toEqual({ name: 'Acme Voice', address: NOREPLY });
        expect(mail!.html).toContain(`Hello ${other.displayName}`);
        expect(mail!.html).toContain('Rae Okafor');
        expect(mail!.html).toContain(person.email);
        expect(mail!.html).toContain('https://portal.acme.example/login');
        expect(mail!.html).not.toContain('token=');
        expect(mail!.text).toContain('Rae Okafor');
      }
      expect(await emailsTo(actor.email, 500)).toHaveLength(0);
      const personal = await emailsTo(person.email);
      expect(personal.map((m) => m.subject)).toEqual(['Your two-step verification was reset']);

      const rows = await db.kysely
        .selectFrom('sent_emails')
        .select(['template', 'to_address'])
        .where('event_id', '=', id)
        .execute();
      expect(rows.map((r) => `${r.template} ${r.to_address}`).sort()).toEqual(
        [
          `mfa-reset ${person.email}`,
          `mfa-reset-admin ${ann.email}`,
          `mfa-reset-admin ${bea.email}`,
        ].sort(),
      );
    });

    it('the master’s admins get a neutral notice', async () => {
      brands.set('master', NEUTRAL);
      const ann = admin('ann');
      admins.set('master', [ann]);
      await publishMfaReset('master', `m-${crypto.randomUUID()}@example.test`);
      await drain();

      const [mail] = await emailsTo(ann.email);
      expect(mail).toBeDefined();
      expect(mail!.from).toEqual({ name: '', address: NOREPLY });
      expect(mail!.html).not.toMatch(/<img/i);
      expect(mail!.html.toLowerCase()).not.toContain('conductor');
      expect(mail!.text.toLowerCase()).not.toContain('conductor');
    });

    it('sends nothing, to anyone, while identity-service is down, and retries later', async () => {
      brands.set('tenant-a', ACME);
      identityDown = true;
      const ann = admin('ann');
      admins.set('tenant-a', [ann]);
      const to = `r-${crypto.randomUUID()}@example.test`;
      const id = await publishMfaReset('tenant-a', to);
      const pass = await drain();

      expect(pass.failed).toBeGreaterThan(0);
      expect(await emailsTo(to, 500)).toHaveLength(0);
      expect(await emailsTo(ann.email, 500)).toHaveLength(0);
      const consumed = await db.kysely
        .selectFrom('consumed_events')
        .selectAll()
        .where('id', '=', id)
        .execute();
      expect(consumed).toHaveLength(0);

      identityDown = false;
      for (let i = 0; i < 5 && (await emailsTo(ann.email, 200)).length === 0; i += 1) {
        await consumer.runOnce();
      }
      expect(await emailsTo(to)).toHaveLength(1);
      expect(await emailsTo(ann.email)).toHaveLength(1);
    });
  });

  it('still sends, neutral, when org-service does not know the org', async () => {
    const to = `u-${crypto.randomUUID()}@example.test`;
    await publishReset('gone-org', to, 'tok-u');
    await drain();

    const [mail] = await emailsTo(to);
    expect(mail).toBeDefined();
    expect(mail!.html).not.toMatch(/<img/i);
    expect(mail!.html).toContain('https://console.platform.test/reset/confirm?token=tok-u');
  });

  it('does not send a link that has already expired', async () => {
    brands.set('tenant-a', ACME);
    const to = `x-${crypto.randomUUID()}@example.test`;
    await publishReset('tenant-a', to, 'tok-x', {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await drain();

    expect(await emailsTo(to, 500)).toHaveLength(0);
  });

  it('sends once per event, even if the same event arrives again', async () => {
    brands.set('tenant-a', ACME);
    const to = `d-${crypto.randomUUID()}@example.test`;
    const id = await publishReset('tenant-a', to, 'tok-d');
    await drain();
    await publishReset('tenant-a', to, 'tok-d', { id });
    await drain();

    expect(await emailsTo(to)).toHaveLength(1);
    const rows = await db.kysely.selectFrom('sent_emails').selectAll().execute();
    expect(rows.filter((r) => r.event_id === id)).toHaveLength(1);
  });

  it('records that an email went out, but never its token or link', async () => {
    brands.set('tenant-a', ACME);
    const to = `r-${crypto.randomUUID()}@example.test`;
    await publishReset('tenant-a', to, 'super-secret-token');
    await drain();

    const rows = await db.kysely.selectFrom('sent_emails').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      template: 'password-reset',
      to_address: to,
      org_id: 'tenant-a',
    });
    expect(JSON.stringify(rows)).not.toContain('super-secret-token');
  });

  it('sends nothing, and consumes nothing, while org-service is down', async () => {
    orgDown = true;
    const to = `o-${crypto.randomUUID()}@example.test`;
    const id = await publishReset('tenant-a', to, 'tok-o');
    const pass = await drain();

    expect(pass.failed).toBeGreaterThan(0);
    expect(await emailsTo(to, 500)).toHaveLength(0);
    const consumed = await db.kysely
      .selectFrom('consumed_events')
      .selectAll()
      .where('id', '=', id)
      .execute();
    expect(consumed).toHaveLength(0);
  });

  it('sends nothing, and consumes nothing, while the mail relay is down', async () => {
    brands.set('tenant-a', ACME);
    const broken = buildConsumer(1); // nothing listens on port 1
    const to = `s-${crypto.randomUUID()}@example.test`;
    const id = await publishReset('tenant-a', to, 'tok-s');
    // Another consumer of the same durable would compete for it, so use the
    // one that shares the durable name and is configured with the dead relay.
    const pass = await drain(broken);

    expect(pass.failed).toBeGreaterThan(0);
    expect(await emailsTo(to, 500)).toHaveLength(0);
    const rows = await db.kysely
      .selectFrom('sent_emails')
      .selectAll()
      .where('event_id', '=', id)
      .execute();
    expect(rows).toHaveLength(0);
  });
});
