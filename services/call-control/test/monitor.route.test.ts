import type { AuditEventInput } from '@cuc/audit';
import type { Grant } from '@cuc/authz';
import {
  AccessUnavailableError,
  createServer,
  signInternalHeaders,
  type AccessClient,
  type ActorAccess,
  type Server,
} from '@cuc/http';
import {
  redisOrSkipReason,
  silentLogger,
  startTestRedis,
  type TestRedisHandle,
} from '@cuc/testing';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { UpstreamError, type ExtensionScope } from '../src/clients.js';
import type { EslApiResult } from '../src/esl/client.js';
import { createMonitorController, type MonitorEsl } from '../src/monitor-control.js';
import { createCallRegistry, type CallRegistry } from '../src/redis/registry.js';
import { registerMonitorRoutes } from '../src/routes/monitor.routes.js';

const skipReason = await redisOrSkipReason();
const SECRET = 'test-internal-header-secret';
const DOMAIN = 'acme.platform.test';

/** One step of what happened, in order, so a test can see the audit came before the ringing. */
type Step = { kind: 'audit'; input: AuditEventInput } | { kind: 'originate'; command: string };

/** A media node: channel variables per channel, and every command, in order. */
class FakeNode implements MonitorEsl {
  readonly vars = new Map<string, Map<string, string>>();
  readonly commands: string[] = [];
  /** What the next `originate` job ends with. */
  originateResult = '+OK supervisor-leg\n';
  failOriginate = false;

  constructor(private readonly steps: Step[]) {}

  channel(uuid: string, vars: Record<string, string>): void {
    this.vars.set(uuid, new Map(Object.entries(vars)));
  }

  sendApi(command: string): Promise<EslApiResult> {
    this.commands.push(command);
    const [verb, uuid = '', name = ''] = command.split(' ');
    if (verb !== 'uuid_getvar') return Promise.resolve({ ok: false, body: '-ERR no' });
    const vars = this.vars.get(uuid);
    if (vars === undefined) return Promise.resolve({ ok: false, body: '-ERR No such channel!' });
    return Promise.resolve({ ok: true, body: vars.get(name) ?? '_undef_' });
  }

  sendBgApi(command: string): Promise<EslApiResult> {
    this.commands.push(`bgapi ${command}`);
    this.steps.push({ kind: 'originate', command });
    if (this.failOriginate) return Promise.reject(new Error('ESL connection closed'));
    const body = this.originateResult;
    return Promise.resolve({ ok: !body.startsWith('-ERR'), body });
  }
}

describe.skipIf(skipReason !== undefined)(
  'listen, whisper and barge (S5-09): POST .../calls/:callUuid/listen|whisper|barge',
  () => {
    let redisHandle: TestRedisHandle;
    let redis: Redis;
    let registry: CallRegistry;
    let app: Server;
    let node: FakeNode;
    let nodeUp = true;
    const steps: Step[] = [];

    /** Each person's roles and grants (identity-service's `/access`), by user id. */
    const access = new Map<string, ActorAccess>();
    let accessDown = false;
    const accessClient: AccessClient = {
      resolve: ({ actorId }) =>
        accessDown
          ? Promise.reject(new AccessUnavailableError('down'))
          : Promise.resolve(access.get(actorId) ?? { roles: [], grants: [] }),
    };
    /** Each person's own extension number, by user id. */
    const numbers = new Map<string, string>();
    /** The tenant's extensions by number (pbx-config-service's by-number lookup). */
    const extensions = new Map<string, ExtensionScope>();
    let pbxDown = false;
    let auditDown = false;

    beforeAll(async () => {
      redisHandle = await startTestRedis();
      redis = new Redis(redisHandle.url);
      registry = createCallRegistry(redis, redisHandle.keyPrefix);

      app = await createServer({
        serviceName: 'call-control-test',
        logger: silentLogger(),
        context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
        // The route-level guard is skipped for these routes (`scopedPermission`); a resolver that
        // says "no" to everything proves the controller alone decides.
        permissions: () => Promise.resolve(false),
      });
      registerMonitorRoutes(app, {
        controller: createMonitorController({
          registry,
          esl: (nodeId) => (nodeId === 'fs-2' && nodeUp ? node : undefined),
          access: accessClient,
          userExtension: (_tenantId, userId) => {
            if (pbxDown) return Promise.reject(new UpstreamError('down'));
            const number = numbers.get(userId);
            return Promise.resolve(
              number === undefined ? undefined : { extensionId: `EXT-${number}`, number },
            );
          },
          extensionScope: (_tenantId, number) =>
            pbxDown
              ? Promise.reject(new UpstreamError('down'))
              : Promise.resolve(extensions.get(number)),
          tenantDomain: () => Promise.resolve(DOMAIN),
          audit: (input) => {
            if (auditDown) return Promise.reject(new Error('database down'));
            steps.push({ kind: 'audit', input });
            return Promise.resolve();
          },
          opensipsSipUri: 'opensips:5060',
          ringTimeoutSeconds: 30,
          logger: silentLogger(),
        }),
      });
      await app.ready();
    });

    afterAll(async () => {
      await app?.close();
      redis?.disconnect();
      await redisHandle?.stop();
    });

    afterEach(() => {
      steps.length = 0;
      access.clear();
      numbers.clear();
      extensions.clear();
      pbxDown = false;
      accessDown = false;
      auditDown = false;
      nodeUp = true;
    });

    /**
     * A carrier call answered by agent 301 on node fs-2: the caller's leg (no extension) bridged to
     * 301's leg. `queueId` puts the call in a queue (`cc_queue` on both legs, as mod_callcenter
     * sets it).
     */
    async function liveCall(
      tenantId: string,
      options: { agent?: string; queueId?: string; state?: 'answered' | 'ringing' } = {},
    ) {
      node = new FakeNode(steps);
      const caller = crypto.randomUUID();
      const agentLeg = crypto.randomUUID();
      const agent = options.agent ?? '301';
      const leg = (callUuid: string, direction: 'inbound' | 'outbound', extension?: string) =>
        registry.createCall(
          {
            callUuid,
            nodeId: 'fs-2',
            tenantId,
            direction,
            state: options.state ?? 'answered',
            startedAt: String(Date.now()),
            from: '+15550100',
            to: agent,
            extension: extension ?? null,
            controls: 'none',
          },
          60_000,
        );
      await leg(caller, 'inbound');
      await leg(agentLeg, 'outbound', agent);
      await registry.updateCall(caller, { bridgedTo: agentLeg });
      await registry.updateCall(agentLeg, { bridgedTo: caller });
      const queueVars = (queueId?: string): Record<string, string> =>
        queueId === undefined ? {} : { cc_queue: `${queueId}@${DOMAIN}` };
      node.channel(caller, queueVars(options.queueId));
      node.channel(agentLeg, queueVars(options.queueId));
      return { caller, agentLeg };
    }

    function person(
      tenantId: string,
      held: { roles?: string[][]; grants?: Omit<Grant, 'principalType' | 'principalId'>[] },
      options: {
        number?: string;
        orgType?: 'tenant' | 'reseller';
        actorType?: 'user' | 'apikey';
      } = {},
    ) {
      const userId = crypto.randomUUID();
      access.set(userId, {
        roles: (held.roles ?? []).map((permissions, index) => ({
          id: `role-${String(index)}`,
          permissions,
        })),
        grants: (held.grants ?? []).map((grant) => ({
          principalType: 'user' as const,
          principalId: userId,
          ...grant,
        })),
      });
      numbers.set(userId, options.number ?? '201');
      const orgType = options.orgType ?? 'tenant';
      return {
        userId,
        headers: signInternalHeaders(SECRET, {
          actorId: userId,
          actorType: options.actorType ?? 'user',
          orgId: tenantId,
          orgType,
          ...(orgType === 'tenant' ? { tenantId } : {}),
          clientIp: '198.51.100.7',
        }),
      };
    }

    const act = (
      tenantId: string,
      callUuid: string,
      mode: 'listen' | 'whisper' | 'barge',
      headers: Record<string, string>,
    ) =>
      app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/calls/${callUuid}/${mode}`,
        headers,
      });

    const originates = () => steps.filter((step) => step.kind === 'originate');
    const audits = () => steps.filter((step) => step.kind === 'audit');

    it('declares each route private and checked against the call itself', () => {
      for (const mode of ['listen', 'whisper', 'barge']) {
        expect(app.registeredRoutes).toContainEqual({
          method: 'POST',
          url: `/v1/tenants/:tenantId/calls/:callUuid/${mode}`,
          permission: `monitor.${mode}`,
          dataClass: 'private',
          public: false,
          scopedPermission: true,
        });
      }
    });

    describe('with the permission across the tenant (the tenant_supervisor role)', () => {
      it('listens: audits first, then rings their own phone through OpenSIPs into eavesdrop on the agent leg, whichever leg was asked', async () => {
        const tenantId = crypto.randomUUID();
        const { caller, agentLeg } = await liveCall(tenantId);
        const supervisor = person(tenantId, { roles: [['monitor.listen']] });

        const response = await act(tenantId, caller, 'listen', supervisor.headers);

        expect(response.statusCode, response.body).toBe(200);
        const body = response.json<{ mode: string; callUuid: string; monitorCallUuid: string }>();
        expect(body).toMatchObject({ mode: 'listen', callUuid: agentLeg });
        expect(steps.map((step) => step.kind)).toEqual(['audit', 'originate']);
        expect(audits()[0]).toEqual({
          kind: 'audit',
          input: {
            actorType: 'user',
            actorId: supervisor.userId,
            actorOrgId: tenantId,
            targetOrgId: tenantId,
            action: 'call.monitor.listen',
            resource: `call:${agentLeg}`,
            dataClass: 'private',
            ip: '198.51.100.7',
            requestId: expect.any(String) as string,
          },
        });
        expect(originates()[0]).toEqual({
          kind: 'originate',
          command:
            `originate {origination_uuid=${body.monitorCallUuid},sip_route_uri=sip:opensips:5060,` +
            `origination_caller_id_name=Listen,origination_caller_id_number=301,originate_timeout=30,` +
            `cuc_tenant_id=${tenantId},cuc_monitor_mode=listen,cuc_monitor_target=${agentLeg},` +
            `eavesdrop_enable_dtmf=false}sofia/internal/201@${DOMAIN} &eavesdrop(${agentLeg})`,
        });
      });

      it('whispers to the agent only, and barges with three_way', async () => {
        const tenantId = crypto.randomUUID();
        const { agentLeg } = await liveCall(tenantId);
        const supervisor = person(tenantId, { roles: [['monitor.whisper', 'monitor.barge']] });

        expect((await act(tenantId, agentLeg, 'whisper', supervisor.headers)).statusCode).toBe(200);
        expect((await act(tenantId, agentLeg, 'barge', supervisor.headers)).statusCode).toBe(200);

        const [whisper, barge] = originates().map((step) => step.command);
        expect(whisper).toContain(',eavesdrop_enable_dtmf=false,eavesdrop_whisper_aleg=true}');
        expect(whisper).toMatch(new RegExp(`&eavesdrop\\(${agentLeg}\\)$`));
        expect(barge).not.toContain('eavesdrop_whisper');
        expect(barge).toMatch(new RegExp(`&three_way\\(${agentLeg}\\)$`));
        expect(audits().map((step) => step.input.action)).toEqual([
          'call.monitor.whisper',
          'call.monitor.barge',
        ]);
      });

      it('holding one mode is not holding another', async () => {
        const tenantId = crypto.randomUUID();
        const { agentLeg } = await liveCall(tenantId);
        const listener = person(tenantId, { roles: [['monitor.listen']] });

        const response = await act(tenantId, agentLeg, 'barge', listener.headers);
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ code: 'insufficient_permission' });
        expect(steps).toEqual([]);
      });
    });

    describe('with a grant scoped to a queue (07 §3.3, G-121)', () => {
      it('whispers to a Q1 agent on a Q1 call, and is refused on a call outside Q1, with nothing audited or rung', async () => {
        const tenantId = crypto.randomUUID();
        const q1 = crypto.randomUUID();
        const q2 = crypto.randomUUID();
        extensions.set('301', { extensionId: 'EXT-301', number: '301', agentQueueIds: [] });
        const lead = person(tenantId, {
          grants: [{ permission: 'monitor.whisper', scope: { type: 'queue', id: q1 } }],
        });

        const inQ1 = await liveCall(tenantId, { queueId: q1 });
        expect((await act(tenantId, inQ1.agentLeg, 'whisper', lead.headers)).statusCode).toBe(200);
        expect(originates()).toHaveLength(1);

        steps.length = 0;
        const inQ2 = await liveCall(tenantId, { queueId: q2 });
        const refused = await act(tenantId, inQ2.agentLeg, 'whisper', lead.headers);
        expect(refused.statusCode).toBe(403);
        expect(refused.json()).toMatchObject({ code: 'insufficient_permission' });
        expect(steps).toEqual([]);

        const noQueue = await liveCall(tenantId);
        expect((await act(tenantId, noQueue.caller, 'whisper', lead.headers)).statusCode).toBe(403);
      });

      it('covers any call whose target is one of the queue’s agents', async () => {
        const tenantId = crypto.randomUUID();
        const q1 = crypto.randomUUID();
        extensions.set('301', { extensionId: 'EXT-301', number: '301', agentQueueIds: [q1] });
        extensions.set('302', { extensionId: 'EXT-302', number: '302', agentQueueIds: [] });
        const lead = person(tenantId, {
          grants: [{ permission: 'monitor.listen', scope: { type: 'queue', id: q1 } }],
        });

        const agentsDirectCall = await liveCall(tenantId, { agent: '301' });
        expect(
          (await act(tenantId, agentsDirectCall.caller, 'listen', lead.headers)).statusCode,
        ).toBe(200);
        const someoneElse = await liveCall(tenantId, { agent: '302' });
        expect((await act(tenantId, someoneElse.caller, 'listen', lead.headers)).statusCode).toBe(
          403,
        );
      });
    });

    describe('with a grant scoped to an extension', () => {
      it('covers calls that extension is on, and nothing else', async () => {
        const tenantId = crypto.randomUUID();
        extensions.set('301', { extensionId: 'EXT-301', number: '301', agentQueueIds: [] });
        extensions.set('302', { extensionId: 'EXT-302', number: '302', agentQueueIds: [] });
        const coach = person(tenantId, {
          grants: [{ permission: 'monitor.barge', scope: { type: 'extension', id: 'EXT-301' } }],
        });

        const on301 = await liveCall(tenantId, { agent: '301' });
        expect((await act(tenantId, on301.agentLeg, 'barge', coach.headers)).statusCode).toBe(200);
        const on302 = await liveCall(tenantId, { agent: '302' });
        expect((await act(tenantId, on302.agentLeg, 'barge', coach.headers)).statusCode).toBe(403);
      });
    });

    describe('refusals', () => {
      it('someone with no monitoring permission anywhere is refused before anything is looked up', async () => {
        const tenantId = crypto.randomUUID();
        const { agentLeg } = await liveCall(tenantId);
        const user = person(tenantId, { roles: [['self.settings']] });
        pbxDown = true; // would fail the request if it were asked

        const response = await act(tenantId, agentLeg, 'listen', user.headers);
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ code: 'insufficient_permission' });
      });

      it('another tenant’s call, an unknown call and a malformed id are all "no such call"', async () => {
        const tenantId = crypto.randomUUID();
        const other = await liveCall(crypto.randomUUID());
        const supervisor = person(tenantId, { roles: [['monitor.listen']] });
        for (const callUuid of [other.agentLeg, crypto.randomUUID(), 'x;y']) {
          const response = await act(tenantId, callUuid, 'listen', supervisor.headers);
          expect([400, 404]).toContain(response.statusCode);
          if (response.statusCode === 404) {
            expect(response.json()).toMatchObject({ code: 'call_not_found' });
          }
        }
        expect(steps).toEqual([]);
      });

      it('H1, the tenant boundary and people only still apply', async () => {
        const tenantId = crypto.randomUUID();
        const { agentLeg } = await liveCall(tenantId);
        const reseller = person(
          crypto.randomUUID(),
          { roles: [['monitor.listen']] },
          {
            orgType: 'reseller',
          },
        );
        const elsewhere = person(crypto.randomUUID(), { roles: [['monitor.listen']] });
        const key = person(tenantId, { roles: [['monitor.listen']] }, { actorType: 'apikey' });

        const walled = await act(tenantId, agentLeg, 'listen', reseller.headers);
        expect(walled.statusCode).toBe(403);
        expect(walled.json()).toMatchObject({ code: 'reseller_private_data_denied' });
        const boundary = await act(tenantId, agentLeg, 'listen', elsewhere.headers);
        expect(boundary.json()).toMatchObject({ code: 'tenant_boundary' });
        const apiKey = await act(tenantId, agentLeg, 'listen', key.headers);
        expect(apiKey.json()).toMatchObject({ code: 'people_only' });
        expect(steps).toEqual([]);
      });

      it('no phone to ring, their own call, and a call not answered yet', async () => {
        const tenantId = crypto.randomUUID();
        const supervisor = person(tenantId, { roles: [['monitor.listen']] }, { number: '301' });

        const own = await liveCall(tenantId, { agent: '301' });
        const ownCall = await act(tenantId, own.agentLeg, 'listen', supervisor.headers);
        expect(ownCall.statusCode).toBe(409);
        expect(ownCall.json()).toMatchObject({ code: 'own_call' });

        const ringing = await liveCall(tenantId, { agent: '302', state: 'ringing' });
        const notAnswered = await act(tenantId, ringing.agentLeg, 'listen', supervisor.headers);
        expect(notAnswered.json()).toMatchObject({ code: 'call_not_answered' });

        numbers.delete(supervisor.userId);
        const other = await liveCall(tenantId, { agent: '302' });
        const noPhone = await act(tenantId, other.agentLeg, 'listen', supervisor.headers);
        expect(noPhone.statusCode).toBe(404);
        expect(noPhone.json()).toMatchObject({ code: 'no_linked_extension' });
        expect(steps).toEqual([]);
      });
    });

    describe('when something is down or the phone does not join', () => {
      it('the phone could not be reached, or was not answered: a 409 each, the attempt audited', async () => {
        const tenantId = crypto.randomUUID();
        const { agentLeg } = await liveCall(tenantId);
        const supervisor = person(tenantId, { roles: [['monitor.listen']] });

        node.originateResult = '-ERR USER_NOT_REGISTERED\n';
        const unreachable = await act(tenantId, agentLeg, 'listen', supervisor.headers);
        expect(unreachable.statusCode).toBe(409);
        expect(unreachable.json()).toMatchObject({ code: 'phone_unreachable' });

        node.originateResult = '-ERR NO_ANSWER\n';
        const unanswered = await act(tenantId, agentLeg, 'listen', supervisor.headers);
        expect(unanswered.json()).toMatchObject({ code: 'phone_not_answered' });
        expect(audits()).toHaveLength(2);
      });

      it('nothing is done when the audit event cannot be written, permissions cannot be checked, or the node is unreachable', async () => {
        const tenantId = crypto.randomUUID();
        const { agentLeg } = await liveCall(tenantId);
        const supervisor = person(tenantId, { roles: [['monitor.listen']] });

        auditDown = true;
        const noAudit = await act(tenantId, agentLeg, 'listen', supervisor.headers);
        expect(noAudit.statusCode).toBe(503);
        expect(noAudit.json()).toMatchObject({ code: 'monitor_unavailable' });
        auditDown = false;

        accessDown = true;
        const noAccess = await act(tenantId, agentLeg, 'listen', supervisor.headers);
        expect(noAccess.json()).toMatchObject({ code: 'permissions_unavailable' });
        accessDown = false;

        nodeUp = false;
        const noNode = await act(tenantId, agentLeg, 'listen', supervisor.headers);
        expect(noNode.json()).toMatchObject({ code: 'media_unavailable' });
        nodeUp = true;

        expect(originates()).toEqual([]);

        node.failOriginate = true;
        const failed = await act(tenantId, agentLeg, 'listen', supervisor.headers);
        expect(failed.statusCode).toBe(503);
        expect(failed.json()).toMatchObject({ code: 'media_node_failed' });
      });
    });
  },
);
