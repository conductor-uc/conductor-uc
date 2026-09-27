import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  clearRegistration,
  createSignInAdmin,
  dockerCurlJson,
  fsCli,
  internalServiceHeaders,
  seedFixtures,
  signInThroughGateway,
  sipInfraOrSkipReason,
  startAgentUas,
  startDelayedCaller,
  startUas,
  stopContainer,
  tenantAdminHeaders,
  withSingleFsNode,
  type SeedResult,
  type UasHandle,
} from '../src/run-scenario.js';

const skipReason = await sipInfraOrSkipReason();

const GATEWAY_URL = 'http://api-gateway:8080';
const PBX_CONFIG_SERVICE_URL = 'http://pbx-config-service:8080';
const TRUNK_SERVICE_URL = 'http://trunk-service:8080';
const IDENTITY_SERVICE_URL = 'http://identity-service:8080';
const CALL_CONTROL_URL = 'http://call-control:8080';
const CARRIER_TARGET_DOMAIN = 'opensips';
const AGENT_CONTAINER = 'sip-test-monitor-agent';
const CALLER_CONTAINER = 'sip-test-monitor-caller';
const SUPERVISOR_PHONE = 'sip-test-monitor-302';
const AGENT_LOGIN_FEATURE_CODE = '*45';

interface LiveLeg {
  readonly callUuid: string;
  readonly state: string;
  readonly extension: string | null;
}

interface AuditEvent {
  readonly action: string;
  readonly resource: string;
  readonly actorId: string;
}

/**
 * S5-09 (G-121), live: a supervisor whispers to a queue agent from their own phone.
 *
 * A carrier call into queue Q1, answered by agent 301. Two people who are not supervisors (the
 * `tenant_user` role, which holds no monitoring), each granted by the tenant's administrator: one
 * granted `monitor.whisper` on Q1, whose own
 * extension is 302 (registered by SIPp through OpenSIPs), and one granted it on Q2, a queue 301
 * does not answer. Through api-gateway, as each signs in from the console:
 *
 * - The Q2 person is refused (403 `insufficient_permission`) and nothing is audited for them.
 * - The Q1 person's whisper rings 302, which answers; the node shows 302's leg eavesdropping on
 *   301's leg with `eavesdrop_whisper_aleg` (only 301 hears the supervisor) and digits disabled.
 * - The whisper is in the tenant's audit trail as `call.monitor.whisper`, by the Q1 person.
 *
 * Every call in the test is pinned to one node (`withSingleFsNode`, G-46): the queue must be, and
 * call-control acts on whichever node holds the call. Needs the stack rebuilt from this branch.
 */
describe.skipIf(skipReason !== undefined)('S5-09 listen, whisper and barge (live SIPp)', () => {
  let seed: SeedResult;

  beforeAll(async () => {
    seed = await seedFixtures();
  }, 60_000);

  afterEach(async () => {
    await Promise.all(
      [AGENT_CONTAINER, CALLER_CONTAINER, SUPERVISOR_PHONE].map((name) => stopContainer(name)),
    );
  });

  async function asAdmin(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) {
    return dockerCurlJson(
      method,
      url,
      body,
      await tenantAdminHeaders(seed.tenantQueue.id, seed.resellerId),
    );
  }

  async function ok<T = { id: string }>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body: unknown,
    status: number,
  ): Promise<T> {
    const response = await asAdmin(method, url, body);
    expect(response.status, `${method} ${url}: ${JSON.stringify(response.json)}`).toBe(status);
    return response.json as T;
  }

  async function extensionId(number: string): Promise<string> {
    const { rows } = await ok<{ rows: { id: string; number: string }[] }>(
      'GET',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${seed.tenantQueue.id}/extensions`,
      undefined,
      200,
    );
    const found = rows.find((row) => row.number === number);
    if (found === undefined) throw new Error(`no seeded extension '${number}'`);
    return found.id;
  }

  function password(number: string): string {
    const entry = seed.extensions[`${seed.tenantQueue.fqdn}/${number}`];
    if (entry === undefined) throw new Error(`no seeded extension ${number}`);
    return entry.password;
  }

  async function trunkAndDid(ip: string, e164: string, queueId: string) {
    const tenantId = seed.tenantQueue.id;
    const trunk = await ok(
      'POST',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks`,
      {
        name: 'S5-09 queue trunk',
        authMode: 'ip',
        host: ip,
        port: 5060,
        transport: 'udp',
        codecs: ['PCMU'],
      },
      201,
    );
    await ok(
      'POST',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks/${trunk.id}/ips`,
      { cidr: `${ip}/32` },
      201,
    );
    const did = await ok(
      'POST',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/dids`,
      { e164, trunkId: trunk.id, destinationType: 'queue', destinationId: queueId },
      201,
    );
    return { trunkId: trunk.id, didId: did.id };
  }

  async function removeTrunkAndDid(ids: { trunkId: string; didId: string }): Promise<void> {
    const tenantId = seed.tenantQueue.id;
    await asAdmin('DELETE', `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/dids/${ids.didId}`);
    await asAdmin('DELETE', `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks/${ids.trunkId}`);
    // As `queue.test.ts`: let a freed IP settle before the next container can reuse it.
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  /**
   * A person of the tenant who holds no monitoring but `monitor.whisper` on one queue, granted by
   * the tenant's administrator through identity-service, which allows exactly that (G-121 (7)).
   */
  async function queueLead(queueId: string) {
    const tenantId = seed.tenantQueue.id;
    const person = await createSignInAdmin(tenantId, seed.resellerId, 'tenant_user');
    await ok(
      'POST',
      `${IDENTITY_SERVICE_URL}/v1/orgs/${tenantId}/grants`,
      {
        principalType: 'user',
        principalId: person.userId,
        permission: 'monitor.whisper',
        scope: { type: 'queue', id: queueId },
      },
      201,
    );
    const token = await signInThroughGateway(GATEWAY_URL, tenantId, person.email, person.password);
    return { userId: person.userId, token };
  }

  /** 301's leg of the queue call, once it has answered (call-control's live calls). */
  async function agentLeg(): Promise<string> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const response = await dockerCurlJson(
        'GET',
        `${CALL_CONTROL_URL}/internal/v1/tenants/${seed.tenantQueue.id}/calls`,
        undefined,
        internalServiceHeaders(),
      );
      const leg = (response.json as { calls?: LiveLeg[] }).calls?.find(
        (call) => call.extension === '301' && call.state === 'answered',
      );
      if (leg !== undefined) return leg.callUuid;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error('301 never answered the queue call (G-47)');
  }

  async function auditFor(resource: string): Promise<AuditEvent[]> {
    const deadline = Date.now() + 30_000;
    let found: AuditEvent[] = [];
    while (Date.now() < deadline) {
      const response = await asAdmin(
        'GET',
        `${IDENTITY_SERVICE_URL}/v1/orgs/${seed.tenantQueue.id}/audit-events?limit=200`,
      );
      found = (response.json as { rows: AuditEvent[] }).rows.filter(
        (event) => event.resource === resource,
      );
      if (found.some((event) => event.action === 'call.monitor.whisper')) return found;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return found;
  }

  it('a person with monitor.whisper on Q1 whispers to Q1’s agent from their own phone; one with it on Q2 is refused', async () => {
    await withSingleFsNode(async () => {
      const tenantId = seed.tenantQueue.id;
      const fqdn = seed.tenantQueue.fqdn;
      await clearRegistration(`301@${fqdn}`);
      await clearRegistration(`302@${fqdn}`);
      const id301 = await extensionId('301');
      const id302 = await extensionId('302');

      const queue = (label: string) =>
        ok(
          'POST',
          `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/queues`,
          { label, strategy: 'ring-all', maxWaitSeconds: 60, announcePosition: false },
          201,
        );
      const q1 = await queue('S5-09 Q1');
      const q2 = await queue('S5-09 Q2');
      let agentId: string | undefined;
      let agent: UasHandle | undefined;
      let trunk: { trunkId: string; didId: string } | undefined;
      let linked = false;
      try {
        agentId = (
          await ok(
            'POST',
            `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/agents`,
            { extensionId: id301 },
            201,
          )
        ).id;
        await ok(
          'POST',
          `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/queues/${q1.id}/tiers`,
          { agentId },
          201,
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Prime mod_callcenter's load of the new queue with a throwaway call, then remove its
        // trunk before the agent registers: `queue.test.ts` explains both steps.
        const e164 = `+1555993${String(Math.floor(1000 + Math.random() * 9000))}`;
        const priming = await startDelayedCaller({
          scenario: 'trunk_invite.xml',
          csvLine: `carrier;${CARRIER_TARGET_DOMAIN};${e164}`,
          containerName: CALLER_CONTAINER,
        });
        trunk = await trunkAndDid(priming.ip, e164, q1.id);
        await priming.result();
        await removeTrunkAndDid(trunk);
        trunk = undefined;
        await stopContainer(CALLER_CONTAINER);

        const q1Lead = await queueLead(q1.id);
        const q2Lead = await queueLead(q2.id);
        await ok(
          'PATCH',
          `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/extensions/${id302}`,
          { userId: q1Lead.userId },
          200,
        );
        linked = true;

        agent = startAgentUas({
          au: '301',
          ap: password('301'),
          authUri: fqdn,
          agentNumber: '301',
          featureCode: AGENT_LOGIN_FEATURE_CODE,
          containerName: AGENT_CONTAINER,
        });
        await agent.ready();
        // G-47: mod_callcenter's lazy queue load never loads tiers; added by hand (idempotent).
        await fsCli(`callcenter_config tier add ${q1.id}@${fqdn} 301@${fqdn} 1 1`);

        const supervisorPhone = startUas({
          au: '302',
          ap: password('302'),
          authUri: fqdn,
          csvLine: `302;${fqdn}`,
          containerName: SUPERVISOR_PHONE,
        });
        await supervisorPhone.ready();

        const caller = await startDelayedCaller({
          scenario: 'trunk_invite_hold_long.xml',
          csvLine: `carrier;${CARRIER_TARGET_DOMAIN};${e164}`,
          containerName: CALLER_CONTAINER,
        });
        trunk = await trunkAndDid(caller.ip, e164, q1.id);
        const leg = await agentLeg();

        // G-119 (3): both legs of the queue call carry the queue, from mod_callcenter's events.
        const live = await dockerCurlJson(
          'GET',
          `${CALL_CONTROL_URL}/internal/v1/tenants/${tenantId}/calls`,
          undefined,
          internalServiceHeaders(),
        );
        const legs = (
          live.json as { calls: (LiveLeg & { queueId: string | null; bridgedTo: string | null })[] }
        ).calls;
        const agentSide = legs.find((call) => call.callUuid === leg);
        expect(agentSide?.queueId, JSON.stringify(legs)).toBe(q1.id);
        // The caller's leg: after mod_callcenter's bridge only it names the other (`bridgedTo`).
        const callerSide = legs.find(
          (call) =>
            call.callUuid !== leg &&
            (call.bridgedTo === leg || call.callUuid === agentSide?.bridgedTo),
        );
        expect(callerSide?.queueId, JSON.stringify(legs)).toBe(q1.id);

        const whisper = (token: string) =>
          dockerCurlJson(
            'POST',
            `${GATEWAY_URL}/v1/tenants/${tenantId}/calls/${leg}/whisper`,
            undefined,
            { authorization: `Bearer ${token}` },
          );

        const refused = await whisper(q2Lead.token);
        expect(refused.status, JSON.stringify(refused.json)).toBe(403);
        expect(refused.json).toMatchObject({ code: 'insufficient_permission' });

        const joined = await whisper(q1Lead.token);
        expect(joined.status, JSON.stringify(joined.json)).toBe(200);
        const { monitorCallUuid } = joined.json as { monitorCallUuid: string };
        expect(joined.json).toMatchObject({ mode: 'whisper', callUuid: leg });

        // On the node: 302's leg is up, eavesdropping on 301's with only 301 hearing it.
        expect(await fsCli(`uuid_getvar ${monitorCallUuid} eavesdrop_whisper_aleg`)).toContain(
          'true',
        );
        expect(await fsCli(`uuid_getvar ${monitorCallUuid} eavesdrop_enable_dtmf`)).toContain(
          'false',
        );
        expect(await fsCli('show channels')).toContain(monitorCallUuid);

        const callerResult = await caller.result();
        expect(callerResult.successfulCalls, callerResult.stdout).toBe(1);
        const phone = await supervisorPhone.result();
        expect(phone.successfulCalls, `302 never answered the whisper\n${phone.stdout}`).toBe(1);

        const audited = await auditFor(`call:${leg}`);
        expect(audited).toContainEqual(
          expect.objectContaining({ action: 'call.monitor.whisper', actorId: q1Lead.userId }),
        );
        expect(audited.filter((event) => event.actorId === q2Lead.userId)).toEqual([]);
      } finally {
        await agent?.stop();
        if (trunk !== undefined) await removeTrunkAndDid(trunk);
        if (linked) {
          await asAdmin(
            'PATCH',
            `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/extensions/${id302}`,
            { userId: null },
          );
        }
        if (agentId !== undefined) {
          await asAdmin(
            'DELETE',
            `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/agents/${agentId}`,
          );
        }
        await asAdmin('DELETE', `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/queues/${q1.id}`);
        await asAdmin('DELETE', `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/queues/${q2.id}`);
      }
    });
  }, 300_000);
});
