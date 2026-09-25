import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  clearRegistration,
  dockerCurlJson,
  seedFixtures,
  sipInfraOrSkipReason,
  startDelayedCaller,
  startUas,
  uasReceivedCall,
  stopContainer,
  tenantAdminHeaders,
  withSingleFsNode,
  type SeedResult,
} from '../src/run-scenario.js';

const skipReason = await sipInfraOrSkipReason();

const PBX_CONFIG_SERVICE_URL = 'http://pbx-config-service:8080';
const VOICEMAIL_SERVICE_URL = 'http://voicemail-service:8080';
const TRUNK_SERVICE_URL = 'http://trunk-service:8080';
const CARRIER_TARGET_DOMAIN = 'opensips';
const CALLER_CONTAINER = 'sip-test-ch-caller';
const UAS_401 = 'sip-test-ch-uas-401';
const UAS_402 = 'sip-test-ch-uas-402';

/**
 * Per-extension call handling (G-109), live. A carrier call reaches extension
 * 401 through a DID, so what happens next is decided by 401's own settings.
 *
 * The forward-always, do-not-disturb and simultaneous-ring cases do not depend
 * on FreeSWITCH continuing after a failed bridge. The busy and unreachable
 * cases do (`continue_on_fail`, G-41), so those two are the ones that say
 * whether the fallbacks work on a real node.
 */
describe.skipIf(skipReason !== undefined)('call handling (live SIPp)', () => {
  let seed: SeedResult;

  beforeAll(async () => {
    seed = await seedFixtures();
  }, 60_000);

  afterEach(async () => {
    await stopContainer(CALLER_CONTAINER);
    await stopContainer(UAS_401);
    await stopContainer(UAS_402);
  });

  /**
   * Calls a service as a tenant administrator would reach it through the
   * gateway: the compose stack trusts signed context headers, the services ask
   * identity-service what that person holds, and a change that is audited
   * needs to know who made it.
   */
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

  const settings = (over: Record<string, unknown>) => ({
    dnd: false,
    dndAction: 'voicemail',
    forwardAlways: null,
    forwardBusy: null,
    forwardNoAnswer: null,
    forwardUnreachable: null,
    noAnswerSeconds: 20,
    simultaneousRing: [],
    ...over,
  });

  interface Setup {
    readonly tenantId: string;
    readonly id401: string;
    readonly id402: string;
    readonly mailboxId: string;
  }

  /**
   * A carrier call to a DID that points at extension 401 while 401 has the
   * given call handling, with [register] deciding which phones are up.
   * Returns what the test needs to assert on, and always cleans up.
   */
  async function scenario(options: {
    handling: (ids: Setup) => Record<string, unknown>;
    register?: (ids: Setup) => Promise<void>;
    caller?: string;
    check: (ids: Setup, result: { successfulCalls: number; stdout: string }) => Promise<void>;
  }): Promise<void> {
    await withSingleFsNode(async () => {
      const tenantId = seed.tenantVoicemail.id;
      const id401 = await extensionId(tenantId, '401');
      const id402 = await extensionId(tenantId, '402');
      await clearRegistration(`401@${seed.tenantVoicemail.fqdn}`);
      await clearRegistration(`402@${seed.tenantVoicemail.fqdn}`);
      const mailbox = await ok<{ id: string }>(
        'POST',
        `${VOICEMAIL_SERVICE_URL}/v1/tenants/${tenantId}/voicemail/mailboxes`,
        { extensionId: id401, pin: '5678' },
        201,
      );
      const ids: Setup = { tenantId, id401, id402, mailboxId: mailbox.id };
      let trunkId: string | undefined;
      let didId: string | undefined;
      try {
        await ok(
          'PUT',
          `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/extensions/${id401}/call-handling`,
          settings(options.handling(ids)),
          200,
        );
        if (options.register !== undefined) await options.register(ids);
        // The event-driven projection into telephony-config's own copy.
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const e164 = `+1555997${String(Math.floor(1000 + Math.random() * 9000))}`;
        const caller = await startDelayedCaller({
          scenario: options.caller ?? 'trunk_invite_hold.xml',
          csvLine: `carrier;${CARRIER_TARGET_DOMAIN};${e164}`,
          containerName: CALLER_CONTAINER,
        });
        const trunk = await ok<{ id: string }>(
          'POST',
          `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks`,
          {
            name: 'call handling trunk',
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
        const did = await ok<{ id: string }>(
          'POST',
          `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/dids`,
          { e164, trunkId, destinationType: 'extension', destinationId: id401 },
          201,
        );
        didId = did.id;

        const result = await caller.result();
        await new Promise((resolve) => setTimeout(resolve, 2500));
        await options.check(ids, result);
      } finally {
        if (didId !== undefined) {
          await call('DELETE', `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/dids/${didId}`);
        }
        if (trunkId !== undefined) {
          await call('DELETE', `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks/${trunkId}`);
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        await call(
          'PUT',
          `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/extensions/${id401}/call-handling`,
          settings({}),
        );
        await call(
          'DELETE',
          `${VOICEMAIL_SERVICE_URL}/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}`,
        );
      }
    });
  }

  function password(number: string): string {
    const entry = seed.extensions[`${seed.tenantVoicemail.fqdn}/${number}`];
    if (entry === undefined) throw new Error(`no seeded extension ${number}`);
    return entry.password;
  }

  async function register(number: string, container: string, answerScenario?: string) {
    const uas = startUas({
      au: number,
      ap: password(number),
      authUri: seed.tenantVoicemail.fqdn,
      csvLine: `${number};${seed.tenantVoicemail.fqdn}`,
      containerName: container,
      ...(answerScenario === undefined ? {} : { answerScenario }),
    });
    await uas.ready();
    return uas;
  }

  async function messages(tenantId: string, mailboxId: string): Promise<unknown[]> {
    const response = await call(
      'GET',
      `${VOICEMAIL_SERVICE_URL}/v1/tenants/${tenantId}/voicemail/mailboxes/${mailboxId}/messages`,
    );
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    return (response.json as { rows: unknown[] }).rows;
  }

  it('do not disturb sends the caller to voicemail, and the phone never rings', async () => {
    await scenario({
      caller: 'trunk_invite_wait_for_bye.xml',
      handling: () => ({ dnd: true, dndAction: 'voicemail' }),
      register: async () => {
        await register('401', UAS_401);
      },
      check: async ({ tenantId, mailboxId }, result) => {
        expect(result.successfulCalls, result.stdout).toBe(1);
        expect((await messages(tenantId, mailboxId)).length).toBeGreaterThanOrEqual(1);
        expect(
          await uasReceivedCall(UAS_401),
          'the registered phone must not have been called',
        ).toBe(false);
      },
    });
  }, 120_000);

  it('forward always sends the call to the other extension instead of ringing this one', async () => {
    let target: Awaited<ReturnType<typeof register>> | undefined;
    await scenario({
      handling: ({ id402 }) => ({ forwardAlways: { type: 'extension', extensionId: id402 } }),
      register: async () => {
        await register('401', UAS_401);
        target = await register('402', UAS_402);
      },
      check: async () => {
        const answered = await target?.result();
        expect(answered?.successfulCalls, answered?.stdout).toBe(1);
        expect(await uasReceivedCall(UAS_401), 'the forwarded phone must not be called').toBe(
          false,
        );
      },
    });
  }, 120_000);

  it('simultaneous ring reaches another extension while this one is not registered', async () => {
    let target: Awaited<ReturnType<typeof register>> | undefined;
    await scenario({
      handling: ({ id402 }) => ({ simultaneousRing: [{ type: 'extension', extensionId: id402 }] }),
      register: async () => {
        target = await register('402', UAS_402);
      },
      check: async () => {
        const answered = await target?.result();
        expect(answered?.successfulCalls, answered?.stdout).toBe(1);
      },
    });
  }, 120_000);

  it('forward on busy: the phone answers 486, and the call goes to voicemail', async () => {
    await scenario({
      caller: 'trunk_invite_wait_for_bye.xml',
      handling: () => ({ forwardBusy: { type: 'voicemail' } }),
      register: async () => {
        await register('401', UAS_401, 'busy_call.xml');
      },
      check: async ({ tenantId, mailboxId }, result) => {
        expect(result.successfulCalls, result.stdout).toBe(1);
        expect((await messages(tenantId, mailboxId)).length).toBeGreaterThanOrEqual(1);
      },
    });
  }, 120_000);

  it('forward when unreachable: no phone is registered, and the call goes to voicemail', async () => {
    await scenario({
      caller: 'trunk_invite_wait_for_bye.xml',
      handling: () => ({ forwardUnreachable: { type: 'voicemail' } }),
      check: async ({ tenantId, mailboxId }, result) => {
        expect(result.successfulCalls, result.stdout).toBe(1);
        expect((await messages(tenantId, mailboxId)).length).toBeGreaterThanOrEqual(1);
      },
    });
  }, 120_000);
});
