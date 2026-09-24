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
import { createVoicemailConsumer } from '../src/consumers/voicemail.consumer.js';
import type { MailBrandResponse } from '../src/domain/brand.js';
import { notificationEvents } from '../src/events.js';
import { createMailer } from '../src/mailer.js';
import { createOrgClient } from '../src/org-client.js';
import type { NotificationServiceDb } from '../src/schema.js';
import { createVoicemailClient } from '../src/voicemail-client.js';
import { clearMailbox, emailsTo, mailpitOrSkipReason, SMTP_HOST, SMTP_PORT } from './mailpit.js';

const skipReason =
  (await databaseOrSkipReason()) ?? (await natsOrSkipReason()) ?? (await mailpitOrSkipReason());

const TOKEN = 'test-internal-service-token';
const NOREPLY = 'noreply@platform.test';
const MAX_ATTACHMENT = 1000;
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

interface FakeMailbox {
  notifyEmail: string | null;
  emailAttachAudio: boolean;
  emailAfter: 'keep' | 'mark_read' | 'delete';
}
interface FakeMessage {
  status: string;
  callerIdName: string | null;
  callerIdNumber: string | null;
  durationMs: number | null;
  sizeBytes: number | null;
  audio: Buffer;
}

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

describe.skipIf(skipReason !== undefined)('voicemail email consumer (S5-07)', () => {
  let handle: TestDatabaseHandle;
  let db: Database<NotificationServiceDb>;
  let nats: TestNatsHandle;
  let bus: Bus;
  let org: HttpServer;
  let vm: HttpServer;
  let orgUrl: string;
  let vmUrl: string;
  const brands = new Map<string, MailBrandResponse>();
  const mailboxes = new Map<string, FakeMailbox>();
  const messages = new Map<string, FakeMessage>();
  /** Requests the fake voicemail-service received, "METHOD path". */
  let calls: string[] = [];
  let voicemailDown = false;
  let logLines: string[] = [];
  let consumer: EventConsumer;

  function buildConsumer(logger: Logger = silentLogger()): EventConsumer {
    return createVoicemailConsumer(
      db,
      bus,
      logger,
      createOrgClient({ baseUrl: orgUrl, internalServiceToken: TOKEN }),
      createVoicemailClient({ baseUrl: vmUrl, internalServiceToken: TOKEN }),
      createMailer({ host: SMTP_HOST, port: SMTP_PORT, secure: false, fromAddress: NOREPLY }),
      {
        pullTimeoutMs: 1000,
        defaultConsoleBase: 'https://console.platform.test',
        linkScheme: 'https',
        maxAttachmentBytes: MAX_ATTACHMENT,
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
    bus = await connectBus({ servers: [nats.server], logger, name: 'notification-vm-test' });
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

    vm = createServer((request, response) => {
      const path = request.url ?? '';
      calls.push(`${request.method ?? ''} ${path}`);
      if (voicemailDown) {
        response.writeHead(503).end();
        return;
      }
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        response.writeHead(401).end();
        return;
      }
      const match =
        /^\/internal\/v1\/tenants\/([^/]+)\/voicemail\/mailboxes\/([^/]+)(?:\/messages\/([^/]+)(?:\/([a-z-]+))?)?$/.exec(
          path,
        );
      if (match === null) {
        response.writeHead(404).end();
        return;
      }
      const [, tenantId, mailboxId, messageId, action] = match;
      // Tenant scoping: a mailbox or message is only visible under its own tenant.
      const box =
        tenantId === TENANT || tenantId === MASTER ? mailboxes.get(mailboxId!) : undefined;
      if (box === undefined) {
        response.writeHead(404).end();
        return;
      }
      if (messageId === undefined) {
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ id: mailboxId, unreadCount: 1, ...box }));
        return;
      }
      const message = messages.get(messageId);
      if (message === undefined) {
        response.writeHead(404).end();
        return;
      }
      if (action === 'audio') {
        response.writeHead(200, { 'content-type': 'audio/wav' }).end(message.audio);
      } else if (action === 'mark-read' || action === 'delete') {
        response.writeHead(action === 'delete' ? 204 : 200, {
          'content-type': 'application/json',
        });
        response.end(action === 'delete' ? undefined : '{}');
      } else {
        const { audio: _audio, ...rest } = message;
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ id: messageId, createdAt: '2026-09-24T19:20:30.000Z', ...rest }));
      }
    });
    await new Promise<void>((resolve) => vm.listen(0, '127.0.0.1', resolve));
    vmUrl = `http://127.0.0.1:${String((vm.address() as AddressInfo).port)}`;

    consumer = buildConsumer();
    await consumer.ensure();
  });

  afterAll(async () => {
    org?.close();
    vm?.close();
    await bus?.close();
    await nats?.stop();
    await db?.destroy();
    await handle?.stop();
  });

  beforeEach(async () => {
    brands.clear();
    brands.set(TENANT, ACME);
    brands.set(MASTER, NEUTRAL);
    mailboxes.clear();
    messages.clear();
    calls = [];
    voicemailDown = false;
    logLines = [];
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

  /** Puts a mailbox and a ready message in the fake voicemail-service and returns the recipient address. */
  function seed(
    mailbox: Partial<FakeMailbox> = {},
    message: Partial<FakeMessage> = {},
  ): { to: string; mailboxId: string; messageId: string } {
    const to = `vm-${crypto.randomUUID()}@example.test`;
    const mailboxId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    mailboxes.set(mailboxId, {
      notifyEmail: to,
      emailAttachAudio: true,
      emailAfter: 'keep',
      ...mailbox,
    });
    messages.set(messageId, {
      status: 'ready',
      callerIdName: 'Pat Caller',
      callerIdNumber: '+15005550123',
      durationMs: 42_000,
      sizeBytes: 9,
      audio: Buffer.from('RIFFwav-bytes'),
      ...message,
    });
    return { to, mailboxId, messageId };
  }

  async function publishCreated(
    tenantId: string | undefined,
    mailboxId: string,
    messageId: string,
    id: string = crypto.randomUUID(),
  ): Promise<string> {
    await bus.publish({
      id,
      type: 'voicemail.message.created',
      schemaVersion: notificationEvents.contract('voicemail.message.created').schemaVersion,
      occurredAt: new Date().toISOString(),
      orgContext: tenantId === undefined ? {} : { tenantId },
      data: { messageId, mailboxId },
    });
    return id;
  }

  it("emails the mailbox's owner in the reseller's brand, with caller, time, length and the audio attached", async () => {
    const { to, mailboxId, messageId } = seed();
    await publishCreated(TENANT, mailboxId, messageId);
    await drain();

    const [mail] = await emailsTo(to);
    expect(mail).toBeDefined();
    expect(mail!.subject).toBe('New voicemail from Pat Caller');
    expect(mail!.from).toEqual({ name: 'Acme Voice', address: NOREPLY });
    expect(mail!.html).toContain('Acme Voice');
    expect(mail!.html).toContain('Acme Voice Ltd.');
    expect(mail!.html).toContain('Pat Caller');
    expect(mail!.html).toContain('+15005550123');
    expect(mail!.html).toContain('0:42');
    expect(mail!.html).toContain('Thu, 24 Sep 2026 19:20 UTC');
    expect(mail!.html).toContain('https://portal.acme.example/voicemail');
    expect(mail!.text).toContain('Pat Caller');
    expect(mail!.text).toContain('The recording is attached');
    expect(mail!.attachments).toHaveLength(1);
    expect(mail!.attachments[0]).toMatchObject({ filename: 'voicemail.wav' });
    expect(mail!.attachments[0]!.contentType).toContain('audio/wav');
    expect(mail!.attachments[0]!.content.toString()).toBe('RIFFwav-bytes');
  });

  it('a master-tier mailbox gets a neutral email: no brand, no logo, no platform name', async () => {
    const { to, mailboxId, messageId } = seed();
    await publishCreated(MASTER, mailboxId, messageId);
    await drain();

    const [mail] = await emailsTo(to);
    expect(mail).toBeDefined();
    expect(mail!.from).toEqual({ name: '', address: NOREPLY });
    expect(mail!.html).not.toContain('Acme');
    expect(mail!.html).not.toMatch(/<img/i);
    for (const part of [mail!.html, mail!.text, mail!.subject, mail!.from.name]) {
      expect(part.toLowerCase()).not.toContain('conductor');
    }
    expect(mail!.html).toContain('https://console.platform.test/voicemail');
  });

  it('sends no attachment when the mailbox did not ask for one', async () => {
    const { to, mailboxId, messageId } = seed({ emailAttachAudio: false });
    await publishCreated(TENANT, mailboxId, messageId);
    await drain();

    const [mail] = await emailsTo(to);
    expect(mail!.attachments).toHaveLength(0);
    expect(mail!.text).not.toContain('too large');
    expect(calls.some((c) => c.endsWith('/audio'))).toBe(false);
  });

  it('falls back to an email without audio, and says so, when the recording is too large', async () => {
    const { to, mailboxId, messageId } = seed(
      {},
      { sizeBytes: MAX_ATTACHMENT + 1, audio: Buffer.alloc(MAX_ATTACHMENT + 1) },
    );
    await publishCreated(TENANT, mailboxId, messageId);
    await drain();

    const [mail] = await emailsTo(to);
    expect(mail).toBeDefined();
    expect(mail!.attachments).toHaveLength(0);
    expect(mail!.html).toContain('too large to attach');
    expect(mail!.text).toContain('too large to attach');
    // It was not even downloaded.
    expect(calls.some((c) => c.endsWith('/audio'))).toBe(false);
  });

  it('also falls back when the bytes turn out bigger than the recorded size said', async () => {
    const { to, mailboxId, messageId } = seed(
      {},
      { sizeBytes: 10, audio: Buffer.alloc(MAX_ATTACHMENT + 5) },
    );
    await publishCreated(TENANT, mailboxId, messageId);
    await drain();

    const [mail] = await emailsTo(to);
    expect(mail!.attachments).toHaveLength(0);
    expect(mail!.text).toContain('too large to attach');
  });

  it('sends nothing for a mailbox with no address', async () => {
    const { to, mailboxId, messageId } = seed({ notifyEmail: null });
    await publishCreated(TENANT, mailboxId, messageId);
    await drain();
    expect(await emailsTo(to, 500)).toHaveLength(0);
    expect(await db.kysely.selectFrom('sent_emails').selectAll().execute()).toHaveLength(0);
  });

  it('drops the event quietly when the message or mailbox has been deleted since', async () => {
    const { to, mailboxId, messageId } = seed();
    messages.delete(messageId);
    await publishCreated(TENANT, mailboxId, messageId);
    const pass = await drain();
    expect(pass.failed).toBe(0);
    expect(await emailsTo(to, 500)).toHaveLength(0);

    const gone = seed();
    mailboxes.delete(gone.mailboxId);
    await publishCreated(TENANT, gone.mailboxId, gone.messageId);
    expect((await drain()).failed).toBe(0);
    expect(await emailsTo(gone.to, 500)).toHaveLength(0);
  });

  it("never reads another tenant's mailbox: the tenant comes from the event, not the mailbox id", async () => {
    // A mailbox id under a tenant the fake does not know is a 404 there.
    const { to, mailboxId, messageId } = seed();
    await publishCreated('some-other-tenant', mailboxId, messageId);
    expect((await drain()).failed).toBe(0);
    expect(await emailsTo(to, 500)).toHaveLength(0);
    expect(calls.every((c) => c.includes('/tenants/some-other-tenant/'))).toBe(true);
  });

  it('ignores an event with no tenant', async () => {
    const { to, mailboxId, messageId } = seed();
    await publishCreated(undefined, mailboxId, messageId);
    expect((await drain()).failed).toBe(0);
    expect(await emailsTo(to, 500)).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("marks the message read after the email when the mailbox says 'mark_read'", async () => {
    const { to, mailboxId, messageId } = seed({ emailAfter: 'mark_read' });
    await publishCreated(TENANT, mailboxId, messageId);
    await drain();
    expect(await emailsTo(to)).toHaveLength(1);
    expect(calls.some((c) => c.startsWith('POST') && c.endsWith(`/${messageId}/mark-read`))).toBe(
      true,
    );
    expect(calls.some((c) => c.endsWith('/delete'))).toBe(false);
  });

  it("deletes the message after the email when the mailbox says 'delete' and the audio was attached", async () => {
    const { to, mailboxId, messageId } = seed({ emailAfter: 'delete' });
    await publishCreated(TENANT, mailboxId, messageId);
    await drain();
    const [mail] = await emailsTo(to);
    expect(mail!.attachments).toHaveLength(1);
    expect(calls.some((c) => c.startsWith('POST') && c.endsWith(`/${messageId}/delete`))).toBe(
      true,
    );
  });

  it('does not delete when the audio was too large to attach: the only copy stays, marked read', async () => {
    const { to, mailboxId, messageId } = seed(
      { emailAfter: 'delete' },
      { sizeBytes: MAX_ATTACHMENT + 1 },
    );
    await publishCreated(TENANT, mailboxId, messageId);
    await drain();
    expect(await emailsTo(to)).toHaveLength(1);
    expect(calls.some((c) => c.endsWith('/delete'))).toBe(false);
    expect(calls.some((c) => c.endsWith('/mark-read'))).toBe(true);
  });

  it('leaves the message alone for keep', async () => {
    const { mailboxId, messageId, to } = seed({ emailAfter: 'keep' });
    await publishCreated(TENANT, mailboxId, messageId);
    await drain();
    expect(await emailsTo(to)).toHaveLength(1);
    expect(calls.some((c) => c.endsWith('/delete') || c.endsWith('/mark-read'))).toBe(false);
  });

  it('sends nothing, and consumes nothing, while voicemail-service is down (the event is retried)', async () => {
    const { to, mailboxId, messageId } = seed();
    voicemailDown = true;
    const id = await publishCreated(TENANT, mailboxId, messageId);
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

  it('sends once per event, even if the same event arrives again', async () => {
    const { to, mailboxId, messageId } = seed();
    const id = await publishCreated(TENANT, mailboxId, messageId);
    await drain();
    await publishCreated(TENANT, mailboxId, messageId, id);
    await drain();
    expect(await emailsTo(to)).toHaveLength(1);
  });

  it('never logs the address, the caller, the audio or the times', async () => {
    const logged = buildConsumer(capturingLogger(logLines));
    // Same durable name as the shared consumer: use this one for the pass.
    const { to, mailboxId, messageId } = seed(
      { emailAfter: 'mark_read' },
      { callerIdName: 'Zed Secretname', callerIdNumber: '+15005559999' },
    );
    await publishCreated(TENANT, mailboxId, messageId);
    await drain(logged);
    expect(await emailsTo(to)).toHaveLength(1);

    const everything = logLines.join('\n');
    expect(everything.length).toBeGreaterThan(0);
    for (const secret of [
      to,
      'Zed Secretname',
      '+15005559999',
      'RIFFwav-bytes',
      '19:20',
      '42000',
    ]) {
      expect(everything).not.toContain(secret);
    }
  });
});
