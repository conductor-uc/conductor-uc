import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { connectBus, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';
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
import { createEmergencyConsumer } from '../src/consumers/emergency.consumer.js';
import type { MailBrandResponse } from '../src/domain/brand.js';
import { notificationEvents } from '../src/events.js';
import { createMailer } from '../src/mailer.js';
import { createOrgClient } from '../src/org-client.js';
import type { NotificationServiceDb } from '../src/schema.js';
import { createTrunkClient } from '../src/trunk-client.js';
import { clearMailbox, emailsTo, mailpitOrSkipReason, SMTP_HOST, SMTP_PORT } from './mailpit.js';

const skipReason =
  (await databaseOrSkipReason()) ?? (await natsOrSkipReason()) ?? (await mailpitOrSkipReason());

const TOKEN = 'test-internal-service-token';
const NOREPLY = 'noreply@platform.test';
const TENANT = 'tenant-a';
const MASTER = 'tenant-master';

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

const LOCATION = {
  label: 'Head office',
  addressLine1: '123 Main St',
  addressLine2: 'Floor 4',
  city: 'Springfield',
  state: 'IL',
  postalCode: '62701',
  country: 'US',
};

/** A logger that keeps everything it is asked to write, to prove none of it is private data. */
function capturingLogger(lines: string[]): Logger {
  const write = (...args: unknown[]) => {
    lines.push(JSON.stringify(args));
  };
  const stub: Record<string, unknown> = {
    trace: write,
    debug: write,
    info: write,
    warn: write,
    error: write,
    fatal: write,
  };
  stub['child'] = () => stub;
  return stub as unknown as Logger;
}

/**
 * S2-06 (G-1): the on-site email for an emergency call, against a real database, NATS and
 * Mailpit, with trunk-service and org-service faked over HTTP.
 */
describe.skipIf(skipReason !== undefined)('emergency email consumer (S2-06)', () => {
  let handle: TestDatabaseHandle;
  let db: Database<NotificationServiceDb>;
  let nats: TestNatsHandle;
  let bus: Bus;
  let org: HttpServer;
  let trunk: HttpServer;
  let orgUrl: string;
  let trunkUrl: string;
  const brands = new Map<string, MailBrandResponse>();
  /** Each tenant's emergency route's addresses; a tenant with none has no route. */
  const routes = new Map<string, string[]>();
  let trunkDown = false;
  let consumer: EventConsumer;

  function buildConsumer(logger: Logger = silentLogger()): EventConsumer {
    return createEmergencyConsumer(
      db,
      bus,
      logger,
      createOrgClient({ baseUrl: orgUrl, internalServiceToken: TOKEN }),
      createTrunkClient({ baseUrl: trunkUrl, internalServiceToken: TOKEN }),
      createMailer({ host: SMTP_HOST, port: SMTP_PORT, secure: false, fromAddress: NOREPLY }),
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
    bus = await connectBus({ servers: [nats.server], logger, name: 'notification-emergency-test' });
    await bus.ensureStreams();

    org = createServer((request, response) => {
      const match = /^\/internal\/v1\/orgs\/([^/]+)\/mail-brand$/.exec(request.url ?? '');
      const brand = match === null ? undefined : brands.get(decodeURIComponent(match[1]!));
      if (request.headers.authorization !== `Bearer ${TOKEN}` || brand === undefined) {
        response.writeHead(brand === undefined ? 404 : 401).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(brand));
    });
    await new Promise<void>((resolve) => org.listen(0, '127.0.0.1', resolve));
    orgUrl = `http://127.0.0.1:${String((org.address() as AddressInfo).port)}`;

    trunk = createServer((request, response) => {
      if (trunkDown) {
        response.writeHead(503).end();
        return;
      }
      const match = /^\/internal\/v1\/tenants\/([^/]+)\/emergency-route$/.exec(request.url ?? '');
      const emails = match === null ? undefined : routes.get(decodeURIComponent(match[1]!));
      if (request.headers.authorization !== `Bearer ${TOKEN}` || emails === undefined) {
        response.writeHead(emails === undefined ? 404 : 401).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'route',
          tenantId: match![1],
          trunkId: 'trunk',
          numbers: ['911'],
          notifyEmails: emails,
        }),
      );
    });
    await new Promise<void>((resolve) => trunk.listen(0, '127.0.0.1', resolve));
    trunkUrl = `http://127.0.0.1:${String((trunk.address() as AddressInfo).port)}`;

    consumer = buildConsumer();
    await consumer.ensure();
  });

  afterAll(async () => {
    org?.close();
    trunk?.close();
    await bus?.close();
    await nats?.stop();
    await db?.destroy();
    await handle?.stop();
  });

  beforeEach(async () => {
    brands.clear();
    brands.set(TENANT, ACME);
    brands.set(MASTER, NEUTRAL);
    routes.clear();
    trunkDown = false;
    await clearMailbox();
  });

  afterEach(async () => {
    await db.kysely.deleteFrom('sent_emails').execute();
    await db.kysely.deleteFrom('consumed_events').execute();
  });

  async function drain(target = consumer): Promise<{ handled: number; failed: number }> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const pass = await target.runOnce();
      if (pass.handled > 0 || pass.failed > 0) return pass;
    }
    return { handled: 0, failed: 0 };
  }

  async function publishEmergency(
    tenantId: string,
    data: Record<string, unknown> = {},
  ): Promise<string> {
    const id = crypto.randomUUID();
    await bus.publish({
      id,
      type: 'call.emergency.initiated',
      schemaVersion: notificationEvents.contract('call.emergency.initiated').schemaVersion,
      occurredAt: '2026-09-24T19:20:00.000Z',
      orgContext: { tenantId },
      data: {
        dialedNumber: '911',
        callingExtensionId: 'ext-101',
        emergencyLocationId: 'loc-1',
        callingNumber: '101',
        callingName: 'Front Desk',
        location: LOCATION,
        ...data,
      },
    });
    return id;
  }

  function addresses(): [string, string] {
    return [
      `desk-${crypto.randomUUID()}@example.test`,
      `safety-${crypto.randomUUID()}@example.test`,
    ];
  }

  it('emails every address on the emergency route: who called, the number, when, and where', async () => {
    const [desk, safety] = addresses();
    routes.set(TENANT, [desk, safety]);
    const eventId = await publishEmergency(TENANT);
    expect(await drain()).toMatchObject({ handled: 1, failed: 0 });

    for (const to of [desk, safety]) {
      const [mail] = await emailsTo(to);
      expect(mail, to).toBeDefined();
      expect(mail!.subject).toBe('Emergency call: 911 dialled from 101 (Front Desk)');
      expect(mail!.from).toEqual({ name: 'Acme Voice', address: NOREPLY });
      for (const part of [mail!.html, mail!.text]) {
        expect(part).toContain('101 (Front Desk)');
        expect(part).toContain('Thu, 24 Sep 2026 19:20 UTC');
        expect(part).toContain('Head office');
        expect(part).toContain('123 Main St');
        expect(part).toContain('Floor 4');
        expect(part).toContain('Springfield, IL 62701');
        expect(part).toContain('https://portal.acme.example/monitoring');
      }
    }
    const sent = await db.kysely
      .selectFrom('sent_emails')
      .select(['template', 'to_address as to'])
      .where('event_id', '=', eventId)
      .execute();
    expect(sent.map((row) => row.to).sort()).toEqual([desk, safety].sort());
    expect(sent.every((row) => row.template === 'emergency')).toBe(true);
  });

  it('says when no location was found, and a master-tier tenant gets a neutral email', async () => {
    const [desk] = addresses();
    routes.set(MASTER, [desk]);
    await publishEmergency(MASTER, {
      callingNumber: null,
      callingName: null,
      location: null,
    });
    await drain();

    const [mail] = await emailsTo(desk);
    expect(mail).toBeDefined();
    expect(mail!.subject).toBe('Emergency call: 911 dialled from an unknown extension');
    expect(mail!.text).toContain('No location was found');
    expect(mail!.from).toEqual({ name: '', address: NOREPLY });
    expect(mail!.html).not.toContain('Acme');
    for (const part of [mail!.html, mail!.text, mail!.subject]) {
      expect(part.toLowerCase()).not.toContain('conductor');
    }
  });

  it('sends nothing when the tenant has no route or no addresses on it', async () => {
    await publishEmergency(TENANT);
    expect(await drain()).toMatchObject({ handled: 1, failed: 0 });
    routes.set(TENANT, []);
    await publishEmergency(TENANT);
    expect(await drain()).toMatchObject({ handled: 1, failed: 0 });
    expect(await db.kysely.selectFrom('sent_emails').selectAll().execute()).toEqual([]);
  });

  it('takes the event again when trunk-service cannot be reached', async () => {
    const [desk] = addresses();
    routes.set(TENANT, [desk]);
    trunkDown = true;
    await publishEmergency(TENANT);
    expect((await drain()).failed).toBeGreaterThanOrEqual(1);
    expect(await emailsTo(desk, 500)).toEqual([]);

    trunkDown = false;
    await expect
      .poll(async () => (await consumer.runOnce()).handled, { timeout: 30_000, interval: 500 })
      .toBe(1);
    expect(await emailsTo(desk)).toHaveLength(1);
  }, 60_000);

  it('logs no address, caller or location', async () => {
    const [desk] = addresses();
    routes.set(TENANT, [desk]);
    const lines: string[] = [];
    const logged = buildConsumer(capturingLogger(lines));
    await publishEmergency(TENANT);
    await drain(logged);
    const all = lines.join('\n');
    for (const secret of [desk, 'Front Desk', '123 Main St', 'Head office']) {
      expect(all).not.toContain(secret);
    }
  });
});
