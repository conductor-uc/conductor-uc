import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createSignInMaster,
  dockerCurlJson,
  seedFixtures,
  signInThroughGateway,
  sipInfraOrSkipReason,
  type SeedResult,
} from '../src/run-scenario.js';

const skipReason = await sipInfraOrSkipReason();

const GATEWAY_URL = 'http://api-gateway:8080';
const NODE = 'freeswitch-2';

type Json = Record<string, unknown>;

interface NodeView {
  readonly nodeId: string;
  readonly status: string;
  readonly draining: boolean;
  readonly weight: number | null;
  readonly dispatcher: string | null;
  readonly sessions: number | null;
  readonly cpuIdlePercent: number | null;
}

/**
 * S4-12 (G-124): the master's operations console against the whole stack, through the gateway:
 * the overview gathers every part, master support may look but not act, and an operator's drain
 * and weight reach OpenSIPs.
 */
describe.skipIf(skipReason !== undefined)('S4-12 operations console (live)', () => {
  let seed: SeedResult;
  let operator: string;
  let support: string;

  beforeAll(async () => {
    seed = await seedFixtures();
    const admin = await createSignInMaster(seed.masterId, 'master_admin');
    const viewer = await createSignInMaster(seed.masterId, 'master_support');
    operator = await signInThroughGateway(GATEWAY_URL, seed.masterId, admin.email, admin.password);
    support = await signInThroughGateway(GATEWAY_URL, seed.masterId, viewer.email, viewer.password);
  }, 90_000);

  afterAll(async () => {
    if (operator === undefined) return;
    await act('POST', `/v1/platform/nodes/${NODE}/undrain`);
    await act('PUT', `/v1/platform/nodes/${NODE}/weight`, { weight: 1 });
  });

  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  function act(method: 'POST' | 'PUT', path: string, body?: unknown, token = operator) {
    return dockerCurlJson(method, `${GATEWAY_URL}${path}`, body, as(token));
  }

  async function overview(token = operator): Promise<Json> {
    const response = await dockerCurlJson(
      'GET',
      `${GATEWAY_URL}/v1/platform/overview`,
      undefined,
      as(token),
    );
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    return response.json as Json;
  }

  async function node(nodeId = NODE): Promise<NodeView> {
    const found = ((await overview())['nodes'] as NodeView[]).find((n) => n.nodeId === nodeId);
    if (found === undefined) throw new Error(`${nodeId} is not in the overview`);
    return found;
  }

  async function waitForNode(check: (n: NodeView) => boolean, what: string): Promise<NodeView> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const current = await node();
      if (check(current)) return current;
      if (Date.now() > deadline)
        throw new Error(`${what} never happened: ${JSON.stringify(current)}`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  it('gathers services, media nodes, the SIP edge, the event bus and the stores', async () => {
    const body = await overview();
    const services: Record<string, Json> = Object.fromEntries(
      (body['services'] as Json[]).map((service) => [String(service['name']), service]),
    );
    for (const name of ['api-gateway', 'call-control', 'telephony-config', 'org-service']) {
      expect(services[name], name).toMatchObject({ status: 'up' });
    }
    expect(services['org-service']?.['outbox']).toMatchObject({ failed: 0 });
    // The uploaders answer on their metrics port with their spool.
    expect(
      ((services['recording-uploader']?.['facts'] ?? []) as Json[]).map((fact) => fact['label']),
    ).toContain('Spool files');

    const nodes = body['nodes'] as NodeView[];
    expect(nodes.map((n) => n.nodeId).sort()).toEqual(['freeswitch', 'freeswitch-2']);
    for (const n of nodes) expect(n).toMatchObject({ status: 'up', dispatcher: 'active' });

    expect(body['signalling']).toMatchObject({ status: 'up' });
    const consumers = (body['events'] as { consumers: Json[] }).consumers.map((c) => c['name']);
    expect(consumers).toContain('telephony-config-nodes');
    const stores: Record<string, unknown> = Object.fromEntries(
      (body['dataStores'] as Json[]).map((store) => [String(store['name']), store['status']]),
    );
    expect(stores).toEqual({ mariadb: 'up', redis: 'up', nats: 'up' });
  });

  it("shows each node's load from its FreeSWITCH heartbeat", async () => {
    // FreeSWITCH sends HEARTBEAT every 20 s.
    const loaded = await waitForNode((n) => n.sessions !== null, 'a heartbeat');
    expect(loaded.cpuIdlePercent).toBeGreaterThan(0);
  }, 45_000);

  it('lets master support look but not act', async () => {
    expect(((await overview(support))['nodes'] as unknown[]).length).toBe(2);
    const refused = await act('POST', `/v1/platform/nodes/${NODE}/drain`, undefined, support);
    expect(refused.status).toBe(403);
    expect((await node()).draining).toBe(false);
  });

  it('S4-13: charts history from Prometheus, a media node per line', async () => {
    // Prometheus scrapes every 15 s; the stack has been up long enough to have points.
    await expect
      .poll(
        async () => {
          const response = await dockerCurlJson(
            'GET',
            `${GATEWAY_URL}/v1/platform/metrics/calls-by-node?range=1h`,
            undefined,
            as(operator),
          );
          expect(response.status, JSON.stringify(response.json)).toBe(200);
          const chart = response.json as {
            unit: string;
            series: { label: string; points: unknown[] }[];
          };
          expect(chart.unit).toBe('count');
          return chart.series.filter((s) => s.points.length > 0).map((s) => s.label);
        },
        { timeout: 60_000, interval: 5_000 },
      )
      .toContain(NODE);
    const unknown = await dockerCurlJson(
      'GET',
      `${GATEWAY_URL}/v1/platform/metrics/not-a-chart?range=1h`,
      undefined,
      as(operator),
    );
    expect(unknown.status).toBe(404);
  }, 90_000);

  it("changes a node's weight in OpenSIPs", async () => {
    const changed = await act('PUT', `/v1/platform/nodes/${NODE}/weight`, { weight: 3 });
    expect(changed.status, JSON.stringify(changed.json)).toBe(200);
    await waitForNode((n) => n.weight === 3, 'weight 3');

    const refused = await act('PUT', `/v1/platform/nodes/${NODE}/weight`, { weight: 0 });
    expect(refused.status).toBe(400);
  }, 45_000);

  it('drains a node and returns it to service', async () => {
    const drained = await act('POST', `/v1/platform/nodes/${NODE}/drain`);
    expect(drained.status, JSON.stringify(drained.json)).toBe(200);
    await waitForNode(
      (n) => n.status === 'draining' && n.dispatcher === 'inactive',
      'drain reaching OpenSIPs',
    );

    const undrained = await act('POST', `/v1/platform/nodes/${NODE}/undrain`);
    expect(undrained.status).toBe(200);
    await waitForNode((n) => n.status === 'up' && n.dispatcher === 'active', 'return to service');
  }, 60_000);
});
