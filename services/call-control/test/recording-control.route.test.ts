import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { encodeRecordingContext } from '@cuc/api-contracts';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';
import {
  redisOrSkipReason,
  silentLogger,
  startTestRedis,
  type TestRedisHandle,
} from '@cuc/testing';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createRecordingControlClient,
  UpstreamError,
  type UserExtensionLookup,
} from '../src/clients.js';
import type { EslApiResult } from '../src/esl/client.js';
import { createRecordingController, type EslCommands } from '../src/recording-control.js';
import { createCallRegistry, type CallRegistry } from '../src/redis/registry.js';
import { registerRecordingControlRoutes } from '../src/routes/recording.routes.js';

const skipReason = await redisOrSkipReason();
const SECRET = 'test-internal-header-secret';
const TOKEN = 'test-internal-service-token';
const SPOOL = '/var/spool/test-rec';

/**
 * A media node as far as ESL goes: channel variables per channel, and every command it was sent,
 * so a test can assert the exact `uuid_getvar`/`uuid_record`/`uuid_setvar` sequence.
 */
class FakeNode implements EslCommands {
  readonly channels = new Map<string, Map<string, string>>();
  readonly commands: string[] = [];
  readonly events: { name: string; headers: Record<string, string> }[] = [];
  recordReply = '+OK Success\n';
  sendEventReply: EslApiResult = { ok: true, body: '+OK 1234' };

  channel(uuid: string, vars: Record<string, string>): void {
    this.channels.set(uuid, new Map(Object.entries(vars)));
  }

  sendApi(command: string): Promise<EslApiResult> {
    this.commands.push(command);
    const [verb, uuid = '', name = '', ...rest] = command.split(' ');
    const vars = this.channels.get(uuid);
    const answer = (body: string) => Promise.resolve({ ok: !body.startsWith('-ERR'), body });
    if (vars === undefined) return answer('-ERR No such channel!');
    switch (verb) {
      case 'uuid_getvar':
        return answer(vars.get(name) ?? '_undef_');
      case 'uuid_setvar':
        if (rest.length === 0) vars.delete(name);
        else vars.set(name, rest.join(' '));
        return answer('+OK');
      case 'uuid_record':
        return answer(this.recordReply);
      default:
        return answer('-ERR unknown command');
    }
  }

  sendEvent(name: string, headers: Readonly<Record<string, string>>): Promise<EslApiResult> {
    this.events.push({ name, headers: { ...headers } });
    return Promise.resolve(this.sendEventReply);
  }
}

interface ControlRequestBody {
  readonly tenantId: string;
  readonly action: string;
  readonly callUuid: string;
  readonly recordingId?: string;
  readonly nodeId: string;
  readonly context: Record<string, unknown>;
  readonly actor: { id: string; orgId: string };
  readonly ip?: string;
  readonly requestId?: string;
}

describe.skipIf(skipReason !== undefined)(
  'recording buttons for live calls (S5-15): POST .../calls/:callUuid/recording',
  () => {
    let redisHandle: TestRedisHandle;
    let redis: Redis;
    let registry: CallRegistry;
    let app: Server;
    let fakeRecording: HttpServer;
    let node: FakeNode;
    let nodeUp = true;
    const injected: { nodeId: string; raw: Record<string, string> }[] = [];

    /** What the fake recording-service was asked, and what it answers next. */
    const asked: ControlRequestBody[] = [];
    let answer: { status: number; body: object } = { status: 200, body: {} };

    /** What each person holds, by user id. */
    const held = new Map<string, string[]>();
    /** Each person's extension number (pbx-config-service's answer), by user id. */
    const numbers = new Map<string, string>();
    let pbxDown = false;
    const userExtension: UserExtensionLookup = (_tenantId, userId) => {
      if (pbxDown) return Promise.reject(new UpstreamError('down'));
      const number = numbers.get(userId);
      return Promise.resolve(
        number === undefined ? undefined : { extensionId: `ext-${number}`, number },
      );
    };

    beforeAll(async () => {
      redisHandle = await startTestRedis();
      redis = new Redis(redisHandle.url);
      registry = createCallRegistry(redis, redisHandle.keyPrefix);

      fakeRecording = createHttpServer((request, response) => {
        let raw = '';
        request.on('data', (chunk: Buffer) => {
          raw += chunk.toString('utf8');
        });
        request.on('end', () => {
          if (
            request.url !== '/internal/v1/recordings/control' ||
            request.headers.authorization !== `Bearer ${TOKEN}`
          ) {
            response.writeHead(401).end();
            return;
          }
          asked.push(JSON.parse(raw) as ControlRequestBody);
          response.writeHead(answer.status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(answer.body));
        });
      });
      await new Promise<void>((resolve) => fakeRecording.listen(0, '127.0.0.1', resolve));
      const recordingUrl = `http://127.0.0.1:${String((fakeRecording.address() as AddressInfo).port)}`;

      app = await createServer({
        serviceName: 'call-control-test',
        logger: silentLogger(),
        context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
        permissions: (actor, permission) =>
          Promise.resolve(held.get(actor.id)?.includes(permission) ?? false),
      });
      registerRecordingControlRoutes(app, {
        controller: createRecordingController({
          registry,
          esl: (nodeId) => (nodeId === 'fs-1' && nodeUp ? node : undefined),
          recording: createRecordingControlClient({
            baseUrl: recordingUrl,
            internalServiceToken: TOKEN,
          }),
          spoolDir: `${SPOOL}/`,
          logger: silentLogger(),
          injectEvent: (nodeId, raw) => injected.push({ nodeId, raw }),
        }),
        userExtension,
      });
      await app.ready();
    });

    afterAll(async () => {
      await app?.close();
      await new Promise((resolve) => fakeRecording?.close(resolve));
      redis?.disconnect();
      await redisHandle?.stop();
    });

    afterEach(() => {
      asked.length = 0;
      injected.length = 0;
      held.clear();
      numbers.clear();
      pbxDown = false;
      nodeUp = true;
    });

    /** A bridged internal call, 402 calling 401: A is the caller's leg and owns the recording. */
    async function liveCall(
      tenantId: string,
      options: { context?: boolean; recordingId?: string; ownerTenant?: string } = {},
    ) {
      node = new FakeNode();
      const a = crypto.randomUUID();
      const b = crypto.randomUUID();
      const leg = (callUuid: string, direction: 'inbound' | 'outbound', extension: string) =>
        registry.createCall(
          {
            callUuid,
            nodeId: 'fs-1',
            tenantId,
            direction,
            state: 'answered',
            startedAt: String(Date.now()),
            from: '402',
            to: '401',
            extension,
            controls: 'on_demand',
          },
          60_000,
        );
      await leg(a, 'inbound', '402');
      await leg(b, 'outbound', '401');
      const context = encodeRecordingContext({
        tenantId,
        direction: 'internal',
        extensionIds: ['EXT-401', 'EXT-402'],
      });
      node.channel(a, {
        cuc_tenant_id: options.ownerTenant ?? tenantId,
        cuc_rec_owner: a,
        ...(options.context === false ? {} : { cuc_rec_ctx: context }),
        ...(options.recordingId === undefined ? {} : { cuc_recording_id: options.recordingId }),
      });
      node.channel(b, { cuc_tenant_id: tenantId, cuc_rec_owner: a });
      return { a, b };
    }

    function person(
      orgId: string,
      permissions: string[],
      orgType: 'tenant' | 'reseller' | 'master' = 'tenant',
    ): { userId: string; headers: Record<string, string> } {
      const userId = crypto.randomUUID();
      held.set(userId, permissions);
      return {
        userId,
        headers: signInternalHeaders(SECRET, {
          actorId: userId,
          actorType: 'user',
          orgId,
          orgType,
          ...(orgType === 'tenant' ? { tenantId: orgId } : {}),
          clientIp: '198.51.100.7',
        }),
      };
    }

    const press = (
      url: string,
      headers: Record<string, string>,
      action: 'start' | 'stop' | 'pause' | 'resume',
    ) => app.inject({ method: 'POST', url, headers, payload: { action } });

    const supervisorUrl = (tenantId: string, callUuid: string) =>
      `/v1/tenants/${tenantId}/calls/${callUuid}/recording`;
    const selfUrl = (tenantId: string, callUuid: string) =>
      `/v1/tenants/${tenantId}/me/live-calls/${callUuid}/recording`;

    describe('a supervisor, on any call of the tenant (recording.control)', () => {
      it('starts an on-demand recording on the owner leg, whichever leg was pressed: the exact ESL commands, recording-service asked first', async () => {
        const tenantId = crypto.randomUUID();
        const { a, b } = await liveCall(tenantId);
        const supervisor = person(tenantId, ['recording.control']);
        answer = {
          status: 200,
          body: { result: 'started', recordingId: 'R-1', fileName: 'R-1.wav', reason: null },
        };

        const response = await press(supervisorUrl(tenantId, b), supervisor.headers, 'start');

        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual({ result: 'started', recordingId: 'R-1', recording: 'on' });
        expect(node.commands).toEqual([
          `uuid_getvar ${b} cuc_rec_owner`,
          `uuid_getvar ${a} cuc_tenant_id`,
          `uuid_getvar ${a} cuc_rec_ctx`,
          `uuid_getvar ${a} cuc_recording_id`,
          `uuid_record ${a} start ${SPOOL}/R-1.wav`,
          `uuid_setvar ${a} cuc_recording_id R-1`,
        ]);
        expect(asked).toEqual([
          {
            tenantId,
            action: 'start',
            callUuid: a,
            nodeId: 'fs-1',
            context: { direction: 'internal', extensionIds: ['EXT-401', 'EXT-402'] },
            actor: { id: supervisor.userId, orgId: tenantId },
            ip: '198.51.100.7',
            requestId: expect.any(String) as string,
          },
        ]);
        expect(node.channels.get(a)?.get('cuc_recording_id')).toBe('R-1');
      });

      it('stops it, naming the running recording, and unsets it on the channel', async () => {
        const tenantId = crypto.randomUUID();
        const { a } = await liveCall(tenantId, { recordingId: 'R-1' });
        const supervisor = person(tenantId, ['recording.control']);
        answer = {
          status: 200,
          body: { result: 'stopped', recordingId: 'R-1', fileName: 'R-1.wav', reason: null },
        };

        const response = await press(supervisorUrl(tenantId, a), supervisor.headers, 'stop');

        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({ result: 'stopped', recording: 'off' });
        expect(asked[0]).toMatchObject({ action: 'stop', recordingId: 'R-1', callUuid: a });
        expect(node.commands.slice(-2)).toEqual([
          `uuid_record ${a} stop ${SPOOL}/R-1.wav`,
          `uuid_setvar ${a} cuc_recording_id`,
        ]);
        expect(node.channels.get(a)?.has('cuc_recording_id')).toBe(false);
      });

      it('pauses with uuid_record mask and fires CUSTOM cuc::recording for the live views; resumes with unmask', async () => {
        const tenantId = crypto.randomUUID();
        const { a, b } = await liveCall(tenantId, { recordingId: 'R-2' });
        const supervisor = person(tenantId, ['recording.control']);

        answer = {
          status: 200,
          body: { result: 'paused', recordingId: 'R-2', fileName: 'R-2.wav', reason: null },
        };
        const paused = await press(supervisorUrl(tenantId, b), supervisor.headers, 'pause');
        expect(paused.statusCode, paused.body).toBe(200);
        expect(paused.json()).toMatchObject({ result: 'paused', recording: 'paused' });
        expect(node.commands.at(-1)).toBe(`uuid_record ${a} mask ${SPOOL}/R-2.wav`);
        expect(node.events).toEqual([
          {
            name: 'CUSTOM',
            headers: {
              'Event-Subclass': 'cuc::recording',
              'Recording-Call-UUID': a,
              'Recording-Action': 'paused',
            },
          },
        ]);

        answer = {
          status: 200,
          body: { result: 'resumed', recordingId: 'R-2', fileName: 'R-2.wav', reason: null },
        };
        const resumed = await press(supervisorUrl(tenantId, b), supervisor.headers, 'resume');
        expect(resumed.json()).toMatchObject({ result: 'resumed', recording: 'on' });
        expect(node.commands.at(-1)).toBe(`uuid_record ${a} unmask ${SPOOL}/R-2.wav`);
        expect(node.events.at(-1)?.headers['Recording-Action']).toBe('resumed');
        expect(injected).toEqual([]);
      });

      it('when the node will not take the event, handles the pause itself so the live views still see it', async () => {
        const tenantId = crypto.randomUUID();
        const { a } = await liveCall(tenantId, { recordingId: 'R-3' });
        const supervisor = person(tenantId, ['recording.control']);
        node.sendEventReply = { ok: false, body: '-ERR' };
        answer = {
          status: 200,
          body: { result: 'paused', recordingId: 'R-3', fileName: 'R-3.wav', reason: null },
        };
        expect(
          (await press(supervisorUrl(tenantId, a), supervisor.headers, 'pause')).statusCode,
        ).toBe(200);
        expect(injected).toEqual([
          {
            nodeId: 'fs-1',
            raw: {
              'Event-Name': 'CUSTOM',
              'Event-Subclass': 'cuc::recording',
              'Recording-Call-UUID': a,
              'Recording-Action': 'paused',
            },
          },
        ]);
      });

      it('a refusal is a 409 with a neutral code, and nothing happens on the node', async () => {
        const tenantId = crypto.randomUUID();
        const { a } = await liveCall(tenantId, { recordingId: 'R-4' });
        const supervisor = person(tenantId, ['recording.control']);
        const cases: [string, string][] = [
          ['not_allowed', 'recording_not_allowed'],
          ['rule_recording', 'rule_recording'],
          ['not_recording', 'not_recording'],
          ['already_recording', 'already_recording'],
          ['already_paused', 'already_paused'],
          ['not_paused', 'not_paused'],
          ['stopped', 'not_recording'],
        ];
        for (const [reason, code] of cases) {
          answer = {
            status: 200,
            body: { result: 'refused', recordingId: 'R-4', fileName: null, reason },
          };
          const response = await press(supervisorUrl(tenantId, a), supervisor.headers, 'stop');
          expect(response.statusCode, reason).toBe(409);
          expect(response.json(), reason).toMatchObject({ code });
          expect(JSON.stringify(response.json())).not.toMatch(/freeswitch|uuid_|node/i);
        }
        expect(node.commands.filter((c) => !c.startsWith('uuid_getvar'))).toEqual([]);
      });

      it('a call with no recording context (no rule allows on demand) is refused without asking recording-service', async () => {
        const tenantId = crypto.randomUUID();
        const { a } = await liveCall(tenantId, { context: false });
        const supervisor = person(tenantId, ['recording.control']);
        const response = await press(supervisorUrl(tenantId, a), supervisor.headers, 'start');
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ code: 'recording_not_allowed' });
        expect(asked).toEqual([]);
      });

      it('when recording-service cannot answer, nothing is done (an action that cannot be audited is not taken)', async () => {
        const tenantId = crypto.randomUUID();
        const { a } = await liveCall(tenantId);
        const supervisor = person(tenantId, ['recording.control']);
        answer = { status: 500, body: {} };
        const response = await press(supervisorUrl(tenantId, a), supervisor.headers, 'start');
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({ code: 'recording_unavailable' });
        expect(node.commands.some((c) => c.startsWith('uuid_record'))).toBe(false);
      });

      it('never puts a malformed recording id on an ESL command line, whoever answered', async () => {
        const tenantId = crypto.randomUUID();
        const { a } = await liveCall(tenantId);
        const supervisor = person(tenantId, ['recording.control']);
        answer = {
          status: 200,
          body: { result: 'started', recordingId: 'x /etc/passwd', fileName: null },
        };
        const response = await press(supervisorUrl(tenantId, a), supervisor.headers, 'start');
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({ code: 'media_node_failed' });
        expect(node.commands.filter((c) => !c.startsWith('uuid_getvar'))).toEqual([]);
      });

      it('a node that is not connected, or that fails the command, is a 503', async () => {
        const tenantId = crypto.randomUUID();
        const { a } = await liveCall(tenantId);
        const supervisor = person(tenantId, ['recording.control']);
        nodeUp = false;
        const down = await press(supervisorUrl(tenantId, a), supervisor.headers, 'start');
        expect(down.statusCode).toBe(503);
        expect(down.json()).toMatchObject({ code: 'media_unavailable' });
        expect(asked).toEqual([]);

        nodeUp = true;
        node.recordReply = '-ERR Cannot record session!';
        answer = {
          status: 200,
          body: { result: 'started', recordingId: 'R-5', fileName: 'R-5.wav', reason: null },
        };
        const failed = await press(supervisorUrl(tenantId, a), supervisor.headers, 'start');
        expect(failed.statusCode).toBe(503);
        expect(failed.json()).toMatchObject({ code: 'media_node_failed' });
        expect(node.channels.get(a)?.has('cuc_recording_id')).toBe(false);
      });

      it('a call not in this tenant, not live, or whose channel names another tenant is not found', async () => {
        const tenantId = crypto.randomUUID();
        const other = crypto.randomUUID();
        const { a } = await liveCall(other);
        const supervisor = person(tenantId, ['recording.control']);
        for (const callUuid of [a, crypto.randomUUID()]) {
          const response = await press(
            supervisorUrl(tenantId, callUuid),
            supervisor.headers,
            'start',
          );
          expect(response.statusCode).toBe(404);
          expect(response.json()).toMatchObject({ code: 'call_not_found' });
        }
        expect(node.commands).toEqual([]);

        const { a: mismatched } = await liveCall(tenantId, { ownerTenant: other });
        const response = await press(
          supervisorUrl(tenantId, mismatched),
          supervisor.headers,
          'start',
        );
        expect(response.statusCode).toBe(404);
        expect(asked).toEqual([]);
      });

      it('needs recording.control; monitor.calls (watching) is not enough', async () => {
        const tenantId = crypto.randomUUID();
        const { a } = await liveCall(tenantId);
        const watcher = person(tenantId, ['monitor.calls', 'self.recording']);
        const response = await press(supervisorUrl(tenantId, a), watcher.headers, 'start');
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ code: 'permission_denied' });
        expect(node.commands).toEqual([]);
      });

      it('H1: a reseller never reaches it, whatever it holds; H2: nor another tenant', async () => {
        const tenantId = crypto.randomUUID();
        const { a } = await liveCall(tenantId);
        const reseller = person(crypto.randomUUID(), ['recording.control'], 'reseller');
        const resold = await press(supervisorUrl(tenantId, a), reseller.headers, 'start');
        expect(resold.statusCode).toBe(403);
        expect(resold.json()).toMatchObject({ code: 'reseller_private_data_denied' });

        const outsider = person(crypto.randomUUID(), ['recording.control']);
        const crossed = await press(supervisorUrl(tenantId, a), outsider.headers, 'start');
        expect(crossed.statusCode).toBe(403);
        expect(crossed.json()).toMatchObject({ code: 'tenant_boundary' });
        expect(node.commands).toEqual([]);
      });

      it('the master acting on a tenant call is audited as the master person', async () => {
        const tenantId = crypto.randomUUID();
        const masterOrg = crypto.randomUUID();
        const { a } = await liveCall(tenantId);
        const master = person(masterOrg, ['recording.control'], 'master');
        answer = {
          status: 200,
          body: { result: 'started', recordingId: 'R-6', fileName: 'R-6.wav', reason: null },
        };
        const response = await press(supervisorUrl(tenantId, a), master.headers, 'start');
        expect(response.statusCode, response.body).toBe(200);
        expect(asked[0]?.actor).toEqual({ id: master.userId, orgId: masterOrg });
      });

      it('refuses an unsigned request, and a caller that is not a person', async () => {
        const tenantId = crypto.randomUUID();
        const { a } = await liveCall(tenantId);
        expect((await press(supervisorUrl(tenantId, a), {}, 'start')).statusCode).toBe(401);
        const key = signInternalHeaders(SECRET, {
          actorId: 'key-1',
          actorType: 'apikey',
          orgId: tenantId,
          orgType: 'tenant',
          tenantId,
        });
        const response = await press(supervisorUrl(tenantId, a), key, 'start');
        expect(response.statusCode).toBe(403);
        expect(node.commands).toEqual([]);
      });

      it('rejects an unknown action and a malformed call id before anything else', async () => {
        const tenantId = crypto.randomUUID();
        const { a } = await liveCall(tenantId);
        const supervisor = person(tenantId, ['recording.control']);
        const bad = await app.inject({
          method: 'POST',
          url: supervisorUrl(tenantId, a),
          headers: supervisor.headers,
          payload: { action: 'toggle' },
        });
        expect(bad.statusCode).toBe(400);
        const weird = await press(
          supervisorUrl(tenantId, 'x%0Aapi%20shutdown'),
          supervisor.headers,
          'start',
        );
        expect(weird.statusCode).toBe(400);
        expect(node.commands).toEqual([]);
      });
    });

    describe('a person, on their own call only (self.recording)', () => {
      it('acts on a leg on their own extension, audited as themselves', async () => {
        const tenantId = crypto.randomUUID();
        const { a, b } = await liveCall(tenantId);
        const me = person(tenantId, ['self.recording']);
        numbers.set(me.userId, '401');
        answer = {
          status: 200,
          body: { result: 'started', recordingId: 'R-7', fileName: 'R-7.wav', reason: null },
        };

        const response = await press(selfUrl(tenantId, b), me.headers, 'start');

        expect(response.statusCode, response.body).toBe(200);
        expect(asked[0]).toMatchObject({
          callUuid: a,
          action: 'start',
          actor: { id: me.userId, orgId: tenantId },
        });
        expect(node.commands.at(-2)).toBe(`uuid_record ${a} start ${SPOOL}/R-7.wav`);
      });

      it('another extension’s leg is not found, even on the same call, and nothing is asked', async () => {
        const tenantId = crypto.randomUUID();
        const { a } = await liveCall(tenantId);
        const me = person(tenantId, ['self.recording']);
        numbers.set(me.userId, '401');
        // A is 402's leg.
        const response = await press(selfUrl(tenantId, a), me.headers, 'start');
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ code: 'call_not_found' });
        expect(node.commands).toEqual([]);
        expect(asked).toEqual([]);
      });

      it('no linked extension is a 404 that says so; pbx-config-service down is a 503', async () => {
        const tenantId = crypto.randomUUID();
        const { b } = await liveCall(tenantId);
        const me = person(tenantId, ['self.recording']);
        const unlinked = await press(selfUrl(tenantId, b), me.headers, 'start');
        expect(unlinked.statusCode).toBe(404);
        expect(unlinked.json()).toMatchObject({ code: 'no_linked_extension' });
        pbxDown = true;
        expect((await press(selfUrl(tenantId, b), me.headers, 'start')).statusCode).toBe(503);
      });

      it('needs self.recording, and only a person of the tenant can use it', async () => {
        const tenantId = crypto.randomUUID();
        const { b } = await liveCall(tenantId);
        const without = person(tenantId, ['self.history']);
        numbers.set(without.userId, '401');
        expect((await press(selfUrl(tenantId, b), without.headers, 'start')).statusCode).toBe(403);

        const master = person(crypto.randomUUID(), ['self.recording'], 'master');
        const response = await press(selfUrl(tenantId, b), master.headers, 'start');
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ code: 'self_service_only' });

        const reseller = person(crypto.randomUUID(), ['self.recording'], 'reseller');
        expect((await press(selfUrl(tenantId, b), reseller.headers, 'start')).statusCode).toBe(403);
        expect(node.commands).toEqual([]);
      });
    });
  },
);
