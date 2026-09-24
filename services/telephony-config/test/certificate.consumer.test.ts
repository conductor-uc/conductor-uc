import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventConsumer } from '@cuc/events';
import { databaseOrSkipReason, natsOrSkipReason } from '@cuc/testing';

import { createCertificateSync } from '../src/certificate-sync.js';
import { createCertificateConsumer } from '../src/consumers/certificate.consumer.js';
import { telephonyEvents } from '../src/events.js';
import { resetOpenSipsSchema, resetSchema, startBusHarness, type BusHarness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await natsOrSkipReason());

const pem = (label: string) => `-----BEGIN CERTIFICATE-----\n${label}\n-----END CERTIFICATE-----\n`;
const key = (label: string) => `-----BEGIN PRIVATE KEY-----\n${label}\n-----END PRIVATE KEY-----\n`;

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

describe.skipIf(skipReason !== undefined)('certificate consumer (org.certificate.issued)', () => {
  let h: BusHarness;

  beforeAll(async () => {
    h = await startBusHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
    await resetOpenSipsSchema(h.opensipsDb);
    h.orgClient.certificates = {};
    h.mi.calls.length = 0;
    await h.bus.jsm.streams.purge('ORG');
  });

  function consumer() {
    const sync = createCertificateSync(h.orgClient, h.opensipsProjection, h.mi, h.logger);
    return createCertificateConsumer(h.db, h.bus, h.logger, sync, { pullTimeoutMs: 1000 });
  }

  async function publish(data: Record<string, unknown>): Promise<void> {
    const contract = telephonyEvents.contract('org.certificate.issued');
    telephonyEvents.assertPayload('org.certificate.issued', data);
    await h.bus.publish({
      id: crypto.randomUUID(),
      type: 'org.certificate.issued',
      schemaVersion: contract.schemaVersion,
      occurredAt: new Date().toISOString(),
      orgContext: {},
      data,
    });
  }

  it('projects a SIP certificate into OpenSIPs and reloads it', async () => {
    const fqdn = `sip.${crypto.randomUUID().slice(0, 8)}.reseller.test`;
    h.orgClient.certificates[fqdn] = {
      resellerId: 'r1',
      version: 1,
      certificate: pem('c'),
      privateKey: key('c'),
    };
    const c = consumer();
    await c.ensure();
    await publish({ fqdn, purpose: 'sip', resellerId: 'r1', version: 1 });

    const pass = await runOnceUntilHandled(c);

    expect(pass.handled).toBeGreaterThanOrEqual(1);
    const row = await h.opensipsDb.kysely
      .selectFrom('tls_mgm')
      .selectAll()
      .where('domain', '=', fqdn)
      .executeTakeFirst();
    expect(row).toMatchObject({
      match_sip_domain: fqdn,
      type: 2,
      certificate: pem('c'),
      private_key: key('c'),
    });
    expect(h.mi.calls).toContain('tls_reload');
  });

  it("ignores a console certificate, which is the gateway's and not OpenSIPs'", async () => {
    const fqdn = `portal.${crypto.randomUUID().slice(0, 8)}.reseller.test`;
    h.orgClient.certificates[fqdn] = {
      resellerId: 'r1',
      version: 1,
      certificate: pem('c'),
      privateKey: key('c'),
    };
    const c = consumer();
    await c.ensure();
    await publish({ fqdn, purpose: 'console', resellerId: 'r1', version: 1 });

    await runOnceUntilHandled(c);

    const row = await h.opensipsDb.kysely
      .selectFrom('tls_mgm')
      .selectAll()
      .where('domain', '=', fqdn)
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });
});
