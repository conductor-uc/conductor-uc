import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  clearRegistration,
  dockerCurlJson,
  runForeground,
  seedFixtures,
  sipInfraOrSkipReason,
  startDelayedCaller,
  stopContainer,
  tenantAdminHeaders,
  waitForTrunkRemoved,
  withSingleFsNode,
  type SeedResult,
} from '../src/run-scenario.js';

const skipReason = await sipInfraOrSkipReason();

const PBX_CONFIG_SERVICE_URL = 'http://pbx-config-service:8080';
const VOICEMAIL_SERVICE_URL = 'http://voicemail-service:8080';
const TRUNK_SERVICE_URL = 'http://trunk-service:8080';
const CARRIER_TARGET_DOMAIN = 'opensips';
const CALLER_CONTAINER = 'sip-test-mwi-caller';
const WATCHER_CONTAINER = 'sip-test-mwi-401';
const OTHER_CONTAINER = 'sip-test-mwi-402';

/**
 * S2-16 (G-42), live: the message-waiting lamp. Extension 401's phone subscribes to its own
 * mailbox's message summary at the edge and is told the lamp is out. A carrier call reaches 401
 * through a DID while no phone is registered for it, goes to voicemail and leaves a message; the
 * phone is then told the lamp is lit. voicemail-service announces the change, telephony-config
 * publishes the summary to the edge over MI, and the edge notifies the subscribed phone.
 *
 * 402, in the same tenant, may not subscribe to 401's summary, and no phone may publish one.
 */
describe.skipIf(skipReason !== undefined)('S2-16 message-waiting lamp (live SIPp)', () => {
  let seed: SeedResult;

  beforeAll(async () => {
    seed = await seedFixtures();
  }, 60_000);

  afterEach(async () => {
    await Promise.all(
      [CALLER_CONTAINER, WATCHER_CONTAINER, OTHER_CONTAINER].map((name) => stopContainer(name)),
    );
  });

  async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) {
    return dockerCurlJson(
      method,
      url,
      body,
      await tenantAdminHeaders(seed.tenantVoicemail.id, seed.resellerId),
    );
  }

  async function ok<T = { id: string }>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    body: unknown,
    status: number,
  ): Promise<T> {
    const response = await call(method, url, body);
    expect(response.status, `${method} ${url}: ${JSON.stringify(response.json)}`).toBe(status);
    return response.json as T;
  }

  async function extensionId(tenantId: string, number: string): Promise<string> {
    const response = await call(
      'GET',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/extensions`,
    );
    const { rows } = response.json as { rows: { id: string; number: string }[] };
    const found = rows.find((row) => row.number === number);
    if (found === undefined) throw new Error(`no seeded extension '${number}'`);
    return found.id;
  }

  function password(number: string): string {
    const entry = seed.extensions[`${seed.tenantVoicemail.fqdn}/${number}`];
    if (entry === undefined) throw new Error(`no seeded extension ${number}`);
    return entry.password;
  }

  const handling = (forwardUnreachable: unknown) => ({
    dnd: false,
    dndAction: 'voicemail',
    forwardAlways: null,
    forwardBusy: null,
    forwardNoAnswer: null,
    forwardUnreachable,
    noAnswerSeconds: 20,
    simultaneousRing: [],
  });

  it('lights the lamp of a phone subscribed to its mailbox when a message is left', async () => {
    await withSingleFsNode(async () => {
      const tenantId = seed.tenantVoicemail.id;
      const fqdn = seed.tenantVoicemail.fqdn;
      const id401 = await extensionId(tenantId, '401');
      await clearRegistration(`401@${fqdn}`);
      const mailbox = await ok(
        'POST',
        `${VOICEMAIL_SERVICE_URL}/v1/tenants/${tenantId}/voicemail/mailboxes`,
        { extensionId: id401, pin: '5678' },
        201,
      );
      let trunkId: string | undefined;
      let didId: string | undefined;
      try {
        await ok(
          'PUT',
          `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/extensions/${id401}/call-handling`,
          handling({ type: 'voicemail' }),
          200,
        );
        // The new, empty mailbox's summary reaching the edge, and the call handling telephony-config.
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // 401's phone subscribes (it is not registered, so calls to 401 go to voicemail).
        const watcher = await startDelayedCaller({
          scenario: 'subscribe_mwi.xml',
          csvLine: `401;${fqdn}`,
          au: '401',
          ap: password('401'),
          authUri: fqdn,
          containerName: WATCHER_CONTAINER,
        });

        // A carrier call to 401 leaves a message.
        const e164 = `+1555996${String(Math.floor(1000 + Math.random() * 9000))}`;
        const caller = await startDelayedCaller({
          scenario: 'trunk_invite_wait_for_bye.xml',
          csvLine: `carrier;${CARRIER_TARGET_DOMAIN};${e164}`,
          containerName: CALLER_CONTAINER,
          startOnSignal: true,
        });
        const trunk = await ok(
          'POST',
          `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks`,
          {
            name: 'message waiting trunk',
            authMode: 'ip',
            host: caller.ip,
            port: 5060,
            transport: 'udp',
            codecs: ['PCMU'],
          },
          201,
        );
        trunkId = trunk.id;
        await ok(
          'POST',
          `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks/${trunkId}/ips`,
          { cidr: `${caller.ip}/32` },
          201,
        );
        const did = await ok(
          'POST',
          `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/dids`,
          { e164, trunkId, destinationType: 'extension', destinationId: id401 },
          201,
        );
        didId = did.id;
        await caller.startWhenRouted({ trunkId, didId });
        const callerResult = await caller.result();
        expect(callerResult.successfulCalls, callerResult.stdout).toBe(1);

        // The phone was told the lamp is out, then that it is lit.
        const watched = await watcher.result();
        expect(watched.successfulCalls, watched.stdout).toBe(1);
      } finally {
        if (didId !== undefined) {
          await call('DELETE', `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/dids/${didId}`);
        }
        if (trunkId !== undefined) {
          await call('DELETE', `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks/${trunkId}`);
          await waitForTrunkRemoved(trunkId);
        }
        await call(
          'PUT',
          `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/extensions/${id401}/call-handling`,
          handling(null),
        );
        await call(
          'DELETE',
          `${VOICEMAIL_SERVICE_URL}/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}`,
        );
      }
    });
  }, 240_000);

  it('refuses a PUBLISH from a phone', async () => {
    const fqdn = seed.tenantVoicemail.fqdn;
    const result = await runForeground({
      scenario: 'publish_expect_403.xml',
      csvLine: `402;${fqdn};401`,
      au: '402',
      ap: password('402'),
      authUri: fqdn,
      containerName: OTHER_CONTAINER,
    });
    expect(result.successfulCalls, result.stdout).toBe(1);
  }, 60_000);

  it("refuses another extension's message summary", async () => {
    const fqdn = seed.tenantVoicemail.fqdn;
    const result = await runForeground({
      scenario: 'subscribe_mwi_expect_403.xml',
      csvLine: `402;${fqdn};401;${fqdn}`,
      au: '402',
      ap: password('402'),
      authUri: fqdn,
      containerName: OTHER_CONTAINER,
    });
    expect(result.successfulCalls, result.stdout).toBe(1);
  }, 60_000);
});
