import type { EventConsumer } from '@cuc/events';
import { databaseOrSkipReason, natsOrSkipReason } from '@cuc/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createVoicemailConsumer } from '../src/consumers/voicemail.consumer.js';
import { telephonyEvents } from '../src/events.js';
import { createMwiPublisher, messageSummary, MWI_EXPIRES_SECONDS } from '../src/mwi.js';
import type { MiParams, OpenSipsMiClient } from '../src/opensips-mi-client.js';
import type { MailboxLamp } from '../src/voicemail-client.js';
import { resetSchema, startBusHarness, type BusHarness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await natsOrSkipReason());

/** As in `org.consumer.test.ts`: a shared NATS server can delay a just-published message past one pull. */
async function runOnceUntilHandled(
  consumer: EventConsumer,
  attempts = 3,
): Promise<{ handled: number; failed: number }> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const pass = await consumer.runOnce();
    if (pass.handled > 0 || pass.failed > 0 || attempt === attempts) return pass;
  }
  throw new Error('unreachable');
}

describe('messageSummary (S2-16)', () => {
  const lamp = { mailboxId: 'm', extensionId: 'e' };

  it('lights the lamp for new messages and gives both counts', () => {
    expect(messageSummary('802@acme.test', { ...lamp, newMessages: 2, savedMessages: 5 })).toBe(
      'Messages-Waiting: yes\r\nMessage-Account: sip:802@acme.test\r\nVoice-Message: 2/5 (0/0)\r\n',
    );
  });

  it('puts the lamp out when only saved messages remain', () => {
    expect(messageSummary('802@acme.test', { ...lamp, newMessages: 0, savedMessages: 5 })).toBe(
      'Messages-Waiting: no\r\nMessage-Account: sip:802@acme.test\r\nVoice-Message: 0/5 (0/0)\r\n',
    );
  });
});

/**
 * S2-16 (G-42): a mailbox's message-waiting summary is announced to the edge (`pua_publish`, to
 * a fake MI client here; the edge's part is proven live in `tests/sip/test/mwi.test.ts`) for the
 * mailbox's extension at its tenant's domain: when `voicemail.mailbox.mwi_changed`
 * arrives, and for every mailbox on the renewing pass.
 */
describe.skipIf(skipReason !== undefined)('message-waiting summaries (S2-16)', () => {
  let h: BusHarness;
  /** What voicemail-service answers, by tenant. */
  let lamps: Record<string, MailboxLamp[]> = {};
  let published: { method: string; params: MiParams | undefined }[] = [];
  let miFails = false;
  const mi: OpenSipsMiClient = {
    call: () => Promise.resolve(),
    query: <T>(method: string, params?: MiParams) => {
      if (miFails) return Promise.reject(new Error('no edge answered'));
      published.push({ method, params });
      return Promise.resolve({ reply: '200 OK' } as T);
    },
  };
  const voicemail = {
    mailboxLamps: (tenantId: string, mailboxId?: string) =>
      Promise.resolve(
        (lamps[tenantId] ?? []).filter(
          (lamp) => mailboxId === undefined || lamp.mailboxId === mailboxId,
        ),
      ),
  };

  beforeAll(async () => {
    h = await startBusHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
    await h.bus.jsm.streams.purge('VOICEMAIL');
    lamps = {};
    published = [];
    miFails = false;
  });

  /** A tenant with domains `fqdns` and one extension (SIP username = number). */
  async function tenant(fqdns: string[], number: string) {
    const tenantId = crypto.randomUUID();
    await h.readModel.upsertTenant(h.db.kysely, { id: tenantId, status: 'active' });
    for (const fqdn of fqdns) {
      await h.readModel.upsertDomain(h.db.kysely, { id: crypto.randomUUID(), tenantId, fqdn });
    }
    const extensionId = crypto.randomUUID();
    await h.readModel.upsertExtension(h.db.kysely, {
      id: extensionId,
      tenantId,
      number,
      username: number,
      ha1: 'x',
      realm: fqdns[0]!,
      callerIdName: null,
      callerIdNumber: null,
      emergencyLocationId: crypto.randomUUID(),
    });
    return { tenantId, extensionId };
  }

  function publisher() {
    return createMwiPublisher({ db: h.db, voicemail, mi, logger: h.logger });
  }

  it('announces a mailbox at its extension’s address', async () => {
    const { tenantId, extensionId } = await tenant(['acme.test'], '802');
    lamps[tenantId] = [{ mailboxId: 'box', extensionId, newMessages: 1, savedMessages: 0 }];

    expect(await publisher().publishMailbox(tenantId, 'box')).toBe(1);
    expect(published).toEqual([
      {
        method: 'pua_publish',
        params: {
          presentity_uri: 'sip:802@acme.test',
          expires: MWI_EXPIRES_SECONDS,
          event_package: 'message-summary',
          content_type: 'application/simple-message-summary',
          body: 'Messages-Waiting: yes\r\nMessage-Account: sip:802@acme.test\r\nVoice-Message: 1/0 (0/0)\r\n',
        },
      },
    ]);
  });

  it('puts the lamp out for a mailbox that is gone, when its extension is known', async () => {
    const { tenantId, extensionId } = await tenant(['acme.test'], '802');
    expect(await publisher().publishMailbox(tenantId, 'gone', extensionId)).toBe(1);
    expect((published[0]!.params as { body: string }).body).toBe(
      'Messages-Waiting: no\r\nMessage-Account: sip:802@acme.test\r\nVoice-Message: 0/0 (0/0)\r\n',
    );
  });

  it('announces nothing for a mailbox that is gone, or whose extension is', async () => {
    const { tenantId } = await tenant(['acme.test'], '802');
    expect(await publisher().publishMailbox(tenantId, 'gone')).toBe(0);
    lamps[tenantId] = [
      { mailboxId: 'box', extensionId: crypto.randomUUID(), newMessages: 1, savedMessages: 0 },
    ];
    expect(await publisher().publishMailbox(tenantId, 'box')).toBe(0);
    expect(published).toEqual([]);
  });

  it('renews every mailbox of every tenant', async () => {
    const a = await tenant(['a.test'], '101');
    const b = await tenant(['b.test'], '201');
    lamps[a.tenantId] = [
      { mailboxId: 'a', extensionId: a.extensionId, newMessages: 0, savedMessages: 3 },
    ];
    lamps[b.tenantId] = [
      { mailboxId: 'b', extensionId: b.extensionId, newMessages: 4, savedMessages: 0 },
    ];

    expect(await publisher().publishAll()).toBe(2);
    const bodies = published.map((call) => (call.params as { body: string }).body).sort();
    expect(bodies).toEqual([
      'Messages-Waiting: no\r\nMessage-Account: sip:101@a.test\r\nVoice-Message: 0/3 (0/0)\r\n',
      'Messages-Waiting: yes\r\nMessage-Account: sip:201@b.test\r\nVoice-Message: 4/0 (0/0)\r\n',
    ]);
  });

  it('announces on voicemail.mailbox.mwi_changed, and takes the event again when the edge is down', async () => {
    const { tenantId, extensionId } = await tenant(['acme.test'], '802');
    lamps[tenantId] = [{ mailboxId: 'box', extensionId, newMessages: 2, savedMessages: 1 }];
    const consumer = createVoicemailConsumer(h.db, h.bus, h.logger, publisher(), {
      pullTimeoutMs: 1000,
    });
    await consumer.ensure();

    miFails = true;
    await h.bus.publish({
      id: crypto.randomUUID(),
      type: 'voicemail.mailbox.mwi_changed',
      schemaVersion: telephonyEvents.contract('voicemail.mailbox.mwi_changed').schemaVersion,
      occurredAt: new Date().toISOString(),
      orgContext: { tenantId },
      data: { mailboxId: 'box' },
    });
    // It may come back, and fail again, within the one pass.
    const down = await runOnceUntilHandled(consumer);
    expect(down.handled).toBe(0);
    expect(down.failed).toBeGreaterThanOrEqual(1);
    expect(published).toEqual([]);

    miFails = false;
    await expect
      .poll(async () => (await consumer.runOnce()).handled, { timeout: 60_000, interval: 1_000 })
      .toBe(1);
    expect(published).toHaveLength(1);
    expect((published[0]!.params as { body: string }).body).toContain('Voice-Message: 2/1 (0/0)');
  }, 90_000);
});
