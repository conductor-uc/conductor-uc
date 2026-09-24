import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  dockerCurlJson,
  dockerCurlUpload,
  seedFixtures,
  sipInfraOrSkipReason,
  startDelayedCaller,
  stopContainer,
  withSingleFsNode,
  type SeedResult,
} from '../src/run-scenario.js';

const skipReason = await sipInfraOrSkipReason();

const CALLFLOW_SERVICE_URL = 'http://callflow-service:8080';
const VOICEMAIL_SERVICE_URL = 'http://voicemail-service:8080';
const PBX_CONFIG_SERVICE_URL = 'http://pbx-config-service:8080';
const CDR_SERVICE_URL = 'http://cdr-service:8080';
const TRUNK_SERVICE_URL = 'http://trunk-service:8080';
const CARRIER_TARGET_DOMAIN = 'opensips';
const CALLER_CONTAINER = 'sip-test-flow-caller';
const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/tone.mp3', import.meta.url));

interface FlowGraph {
  readonly entryPoints: Record<string, string>;
  readonly nodes: readonly object[];
  readonly edges: readonly object[];
}

/**
 * S3-11 step 5: a carrier call traverses a published call flow into voicemail.
 * `flow_runner.lua` had never taken a live call before this test; every
 * finding it produces belongs in docs/decisions.md.
 *
 * The flow is built and published through callflow-service's own API, a DID
 * is bound to it (`destinationType: 'flow'`), and a trunk-side SIPp caller
 * dials the DID. The flow's only node is a `voicemail`, so the message
 * existing proves the runner fetched the IR, walked to the node and handed
 * the call to `voicemail.lua`.
 */
describe.skipIf(skipReason !== undefined)('S3-11 published call flow (live SIPp)', () => {
  let seed: SeedResult;

  beforeAll(async () => {
    seed = await seedFixtures();
  }, 60_000);

  afterEach(async () => {
    await stopContainer(CALLER_CONTAINER);
  });

  async function extensionId(tenantId: string, number: string): Promise<string> {
    const response = await dockerCurlJson(
      'GET',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/extensions`,
    );
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    const { rows } = response.json as { rows: { id: string; number: string }[] };
    const found = rows.find((row) => row.number === number);
    if (found === undefined) throw new Error(`no seeded extension '${number}'`);
    return found.id;
  }

  async function ok(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    body: unknown,
    status: number,
  ): Promise<{ id: string }> {
    const response = await dockerCurlJson(method, url, body);
    expect(response.status, `${method} ${url}: ${JSON.stringify(response.json)}`).toBe(status);
    return response.json as { id: string };
  }

  async function readyPrompt(tenantId: string): Promise<string> {
    const created = await dockerCurlJson(
      'POST',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/media-assets`,
      { kind: 'prompt', label: 'S3-11 menu prompt', contentType: 'audio/mpeg' },
    );
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const { asset, uploadUrl } = created.json as { asset: { id: string }; uploadUrl: string };
    expect((await dockerCurlUpload(uploadUrl, FIXTURE_PATH, 'audio/mpeg')).status).toBe(200);
    const finalized = await dockerCurlJson(
      'POST',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/media-assets/${asset.id}/finalize`,
    );
    expect(finalized.status, JSON.stringify(finalized.json)).toBe(200);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const got = await dockerCurlJson(
        'GET',
        `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/media-assets/${asset.id}`,
      );
      const status = (got.json as { status?: string } | undefined)?.status;
      if (status === 'ready') return asset.id;
      if (status === 'failed' || Date.now() > deadline) {
        throw new Error(`prompt ${asset.id} not ready: ${JSON.stringify(got.json)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  async function callFlow(
    scenario: string,
    graphFor: (ids: { mailboxId: string; promptId: string }) => FlowGraph,
    needsPrompt: boolean,
  ): Promise<void> {
    await withSingleFsNode(async () => {
      const tenantId = seed.tenantVoicemail.id;
      const mailbox = await ok(
        'POST',
        `${VOICEMAIL_SERVICE_URL}/v1/tenants/${tenantId}/voicemail/mailboxes`,
        { extensionId: await extensionId(tenantId, '401'), pin: '5678' },
        201,
      );
      const promptId = needsPrompt ? await readyPrompt(tenantId) : '';
      let flowId: string | undefined;
      let trunkId: string | undefined;
      let didId: string | undefined;
      try {
        const flow = await ok(
          'POST',
          `${CALLFLOW_SERVICE_URL}/v1/tenants/${tenantId}/flows`,
          { name: 'S3-11 live flow' },
          201,
        );
        flowId = flow.id;
        await ok(
          'PUT',
          `${CALLFLOW_SERVICE_URL}/v1/tenants/${tenantId}/flows/${flowId}/draft`,
          graphFor({ mailboxId: mailbox.id, promptId }),
          200,
        );
        await ok(
          'POST',
          `${CALLFLOW_SERVICE_URL}/v1/tenants/${tenantId}/flows/${flowId}/publish`,
          {},
          201,
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const e164 = `+1555998${String(Math.floor(1000 + Math.random() * 9000))}`;
        const caller = await startDelayedCaller({
          scenario,
          csvLine: `carrier;${CARRIER_TARGET_DOMAIN};${e164}`,
          containerName: CALLER_CONTAINER,
        });
        const trunk = await ok(
          'POST',
          `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks`,
          {
            name: 'S3-11 flow trunk',
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
          { e164, trunkId, destinationType: 'flow', destinationId: flowId },
          201,
        );
        didId = did.id;

        const result = await caller.result();
        expect(result.successfulCalls, result.stdout).toBe(1);

        await new Promise((resolve) => setTimeout(resolve, 2000));
        const messages = await dockerCurlJson(
          'GET',
          `${VOICEMAIL_SERVICE_URL}/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}/messages`,
        );
        expect(messages.status, JSON.stringify(messages.json)).toBe(200);
        expect((messages.json as { rows: unknown[] }).rows.length).toBeGreaterThanOrEqual(1);

        // The call leaves a CDR for the tenant (the export itself is walked in tests/e2e).
        let cdrRows: unknown[] = [];
        for (let attempt = 0; attempt < 15 && cdrRows.length === 0; attempt += 1) {
          const cdrs = await dockerCurlJson(
            'GET',
            `${CDR_SERVICE_URL}/v1/tenants/${tenantId}/cdrs`,
          );
          expect(cdrs.status, JSON.stringify(cdrs.json)).toBe(200);
          cdrRows = (cdrs.json as { rows: unknown[] }).rows;
          if (cdrRows.length === 0) await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        expect(cdrRows.length).toBeGreaterThanOrEqual(1);
      } finally {
        if (didId !== undefined) {
          await dockerCurlJson(
            'DELETE',
            `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/dids/${didId}`,
          );
        }
        if (trunkId !== undefined) {
          await dockerCurlJson(
            'DELETE',
            `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks/${trunkId}`,
          );
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        await dockerCurlJson(
          'DELETE',
          `${VOICEMAIL_SERVICE_URL}/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}`,
        );
      }
    });
  }

  it('a DID bound to a published flow reaches its voicemail node and records a message', async () => {
    await callFlow(
      'trunk_invite_wait_for_bye.xml',
      ({ mailboxId }) => ({
        entryPoints: { main: 'mail' },
        nodes: [
          { id: 'mail', type: 'voicemail', config: { mailboxId }, position: { x: 0, y: 0 } },
          { id: 'bye', type: 'hangup', config: {}, position: { x: 200, y: 0 } },
        ],
        edges: [{ from: 'mail', port: 'next', to: 'bye' }],
      }),
      false,
    );
  }, 60_000);

  it('the caller presses 2 at a menu and is taken to voicemail', async () => {
    await callFlow(
      'trunk_invite_press_2.xml',
      ({ mailboxId, promptId }) => ({
        entryPoints: { main: 'menu' },
        nodes: [
          {
            id: 'menu',
            type: 'menu',
            config: { promptMediaAssetId: promptId, timeoutSeconds: 10, maxInvalidAttempts: 3 },
            position: { x: 0, y: 0 },
            openPorts: ['2'],
          },
          { id: 'mail', type: 'voicemail', config: { mailboxId }, position: { x: 200, y: 0 } },
          { id: 'bye', type: 'hangup', config: {}, position: { x: 400, y: 0 } },
        ],
        edges: [
          { from: 'menu', port: '2', to: 'mail' },
          { from: 'menu', port: 'timeout', to: 'bye' },
          { from: 'menu', port: 'invalid', to: 'bye' },
          { from: 'mail', port: 'next', to: 'bye' },
        ],
      }),
      true,
    );
  }, 90_000);
});
