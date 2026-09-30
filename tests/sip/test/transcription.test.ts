import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  seedFixtures,
  sipInfraOrSkipReason,
  startDelayedCaller,
  stopContainer,
  tenantAdminCurlJson,
  waitForTrunkRemoved,
  withSingleFsNode,
  type SeedResult,
} from '../src/run-scenario.js';

const skipReason = await sipInfraOrSkipReason();

const VOICEMAIL_SERVICE_URL = 'http://voicemail-service:8080';
const PBX_CONFIG_SERVICE_URL = 'http://pbx-config-service:8080';
const TRUNK_SERVICE_URL = 'http://trunk-service:8080';
const CARRIER_TARGET_DOMAIN = 'opensips';
const CALLER_CONTAINER = 'sip-test-transcription-caller';

interface MessageRow {
  readonly id: string;
  readonly status: string;
  readonly transcript: string | null;
  readonly transcriptStatus: string;
}

/**
 * S5-06 (O-3), live: a carrier call to a DID bound to a mailbox speaks a short message
 * (`trunk_invite_speak.xml`); FreeSWITCH records it, the node uploader delivers it, and, the
 * tenant having opted in to the self-hosted engine, the transcriber sends it to that engine and
 * keeps the words.
 *
 * Needs the self-hosted engine, which the everyday stack does not run (the `transcription`
 * compose profile, with `TRANSCRIPTION_SELF_HOSTED_URL` set for voicemail-service): without it
 * the test skips itself, saying so.
 */
describe.skipIf(skipReason !== undefined)('S5-06 voicemail transcription (live)', () => {
  let seed: SeedResult;

  beforeAll(async () => {
    seed = await seedFixtures();
  }, 60_000);

  afterEach(async () => {
    await stopContainer(CALLER_CONTAINER);
  });

  async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) {
    return tenantAdminCurlJson(seed.resellerId, method, url, body);
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

  it('turns a spoken voicemail into text with the self-hosted engine', async (context) => {
    const tenantId = seed.tenantVoicemail.id;
    const settingsUrl = `${VOICEMAIL_SERVICE_URL}/v1/tenants/${tenantId}/voicemail/transcription`;
    const settings = await ok<{ availableEngines: string[] }>('GET', settingsUrl, undefined, 200);
    if (!settings.availableEngines.includes('self_hosted')) {
      context.skip(
        'no self-hosted transcription engine in this stack (compose profile `transcription`)',
      );
    }

    await withSingleFsNode(async () => {
      const extensions = await ok<{ rows: { id: string; number: string }[] }>(
        'GET',
        `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/extensions`,
        undefined,
        200,
      );
      const extension = extensions.rows.find((row) => row.number === '401');
      if (extension === undefined) throw new Error('no seeded extension 401');
      const mailbox = await ok(
        'POST',
        `${VOICEMAIL_SERVICE_URL}/v1/tenants/${tenantId}/voicemail/mailboxes`,
        { extensionId: extension.id, pin: '5678' },
        201,
      );
      let trunkId: string | undefined;
      let didId: string | undefined;
      try {
        await ok('PUT', settingsUrl, { enabled: true, engine: 'self_hosted' }, 200);
        // The new mailbox reaching telephony-config's copy.
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const e164 = `+1555995${String(Math.floor(1000 + Math.random() * 9000))}`;
        const caller = await startDelayedCaller({
          scenario: 'trunk_invite_speak.xml',
          csvLine: `carrier;${CARRIER_TARGET_DOMAIN};${e164}`,
          containerName: CALLER_CONTAINER,
          startOnSignal: true,
          extraArgs: ['-mp', '7000'],
        });
        const trunk = await ok(
          'POST',
          `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks`,
          {
            name: 'transcription trunk',
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
        didId = (
          await ok(
            'POST',
            `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/dids`,
            { e164, trunkId, destinationType: 'voicemail', destinationId: mailbox.id },
            201,
          )
        ).id;
        await caller.startWhenRouted({ trunkId, didId });
        const result = await caller.result();
        expect(result.successfulCalls, result.stdout).toBe(1);

        // Delivered by the uploader, then transcribed: poll for the text.
        let last: MessageRow[] = [];
        await expect
          .poll(
            async () => {
              last = (
                await ok<{ rows: MessageRow[] }>(
                  'GET',
                  `${VOICEMAIL_SERVICE_URL}/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}/messages`,
                  undefined,
                  200,
                )
              ).rows;
              return last[0]?.transcriptStatus;
            },
            { timeout: 120_000, interval: 1_000 },
          )
          .toBe('done');
        const text = (last[0]?.transcript ?? '').toLowerCase();
        expect(text, JSON.stringify(last)).toContain('pat');
        expect(text, JSON.stringify(last)).toContain('accounting');
      } finally {
        await call('PUT', settingsUrl, { enabled: false, engine: 'self_hosted' });
        if (didId !== undefined) {
          await call('DELETE', `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/dids/${didId}`);
        }
        if (trunkId !== undefined) {
          await call('DELETE', `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks/${trunkId}`);
          await waitForTrunkRemoved(trunkId);
        }
        await call(
          'DELETE',
          `${VOICEMAIL_SERVICE_URL}/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}`,
        );
      }
    });
  }, 240_000);
});
