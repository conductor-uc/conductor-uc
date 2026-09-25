import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, redisOrSkipReason } from '@cuc/testing';
import { createServer, type Server } from '@cuc/http';

import { toContextId } from '../src/context-id.js';
import {
  createRecordingClient,
  type RecordingCall,
  type RecordingClient,
  type RecordingControlRequest,
  type RecordingControlResult,
  type RecordingDirective,
} from '../src/recording-client.js';
import { decodeRecordingContext } from '../src/recording-context.js';
import { registerFsRoutes } from '../src/routes/fs.routes.js';
import {
  CONSENT_TONE,
  FEATURE_CODE_DONE_TONE,
  FEATURE_CODE_REFUSED_TONE,
  RECORDING_REFUSAL_TONE,
} from '../src/xml.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await redisOrSkipReason());
const TOKEN = 'test-fs-xml-curl-token';
const BASIC_AUTH = `Basic ${Buffer.from(`fs-node:${TOKEN}`).toString('base64')}`;
const DOMAIN = 'acme.platform.test';
const SPOOL = '/var/spool/cuc/rec';
const RECORDING_ID = '5f1c2b7e-0a3d-4c1e-9d2a-7b8e4f6a1c3d';

/** A recording client whose answer the test sets, and which remembers what it was asked. */
class FakeRecording implements RecordingClient {
  calls: RecordingCall[] = [];
  directive: RecordingDirective = { kind: 'none' };
  decide(call: RecordingCall): Promise<RecordingDirective> {
    this.calls.push(call);
    return Promise.resolve(this.directive);
  }
  unavailableCount(): number {
    return 0;
  }
  failClosedTenants: string[] = [];
  listFailClosedTenants(): Promise<string[]> {
    return Promise.resolve(this.failClosedTenants);
  }
  controlCalls: RecordingControlRequest[] = [];
  controlResult: RecordingControlResult | Error = {
    result: 'refused',
    recordingId: null,
    fileName: null,
    reason: 'not_allowed',
  };
  control(request: RecordingControlRequest): Promise<RecordingControlResult> {
    this.controlCalls.push(request);
    return this.controlResult instanceof Error
      ? Promise.reject(this.controlResult)
      : Promise.resolve(this.controlResult);
  }
}

const record = (over: Partial<Extract<RecordingDirective, { kind: 'record' }>> = {}) =>
  ({
    kind: 'record',
    recordingId: RECORDING_ID,
    fileName: `${RECORDING_ID}.wav`,
    announce: false,
    consentAssetId: null,
    ...over,
  }) satisfies RecordingDirective;

/**
 * `/fs/dialplan`'s recording decision (S5-02). Verified as XML strings only: nothing here runs
 * FreeSWITCH, so that `record_session` really writes the file, that the tone or asset really plays,
 * and their order on a live call are unproven until the SIP test stack exercises them.
 */
describe.skipIf(skipReason !== undefined)('/fs/dialplan recording decision (S5-02)', () => {
  let h: Harness;
  let app: Server;
  const fake = new FakeRecording();

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({ serviceName: 'telephony-config', logger: h.logger });
    registerFsRoutes(
      app,
      h.db,
      h.readModel,
      TOKEN,
      'opensips:5060',
      h.logger,
      h.orgClient,
      h.pbxConfig,
      h.storage,
      h.voicemail,
      h.redis,
      h.callflow,
      h.affinity,
      h.callControl,
      'http://telephony-config-test:8080',
      { client: fake, spoolDir: SPOOL },
    );
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await h?.close();
  });
  afterEach(async () => {
    fake.controlCalls = [];
    fake.controlResult = {
      result: 'refused',
      recordingId: null,
      fileName: null,
      reason: 'not_allowed',
    };
    await resetSchema(h.db);
    fake.calls = [];
    fake.directive = { kind: 'none' };
    h.orgClient.limits = {};
  });

  async function seedTenant(): Promise<string> {
    const tenantId = crypto.randomUUID();
    await h.readModel.upsertTenant(h.db.kysely, { id: tenantId, status: 'active' });
    await h.readModel.upsertDomain(h.db.kysely, {
      id: crypto.randomUUID(),
      tenantId,
      fqdn: DOMAIN,
    });
    await h.readModel.setTenantCountry(h.db.kysely, tenantId, 'US');
    return tenantId;
  }

  async function seedExtension(tenantId: string, number: string): Promise<string> {
    const id = crypto.randomUUID();
    await h.readModel.upsertExtension(h.db.kysely, {
      id,
      tenantId,
      number,
      username: number,
      ha1: 'a'.repeat(32),
      realm: DOMAIN,
      callerIdName: null,
      callerIdNumber: null,
      emergencyLocationId: crypto.randomUUID(),
    });
    return id;
  }

  async function seedTrunk(tenantId: string): Promise<string> {
    const trunkId = crypto.randomUUID();
    await h.readModel.upsertTrunk(h.db.kysely, {
      id: trunkId,
      tenantId,
      name: 'Carrier',
      authMode: 'ip',
      host: 'carrier.test',
      port: 5060,
      transport: 'udp',
      username: null,
      secret: null,
      fromDomain: null,
      status: 'active',
      callerIdName: null,
      callerIdNumber: '+15550001111',
    });
    return trunkId;
  }

  async function seedOutbound(tenantId: string): Promise<void> {
    const trunkId = await seedTrunk(tenantId);
    await h.readModel.upsertOutboundRoute(h.db.kysely, {
      id: crypto.randomUUID(),
      tenantId,
      priority: 0,
      pattern: '',
      trunkIds: [trunkId],
      strip: 0,
      prepend: null,
    });
  }

  async function dial(fields: Record<string, string>, query = ''): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/fs/dialplan${query}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: BASIC_AUTH },
      payload: new URLSearchParams({
        section: 'dialplan',
        'Caller-Context': 'public',
        'Unique-ID': 'call-uuid-1',
        ...fields,
      }).toString(),
    });
    expect(response.statusCode).toBe(200);
    return response.body;
  }

  const internal = (tenantId: string, number = '101', from = '100') =>
    dial({
      'Caller-Destination-Number': number,
      'variable_sip_h_X-Call-Direction': 'internal',
      'variable_sip_h_X-Tenant-Id': tenantId,
      variable_sip_from_user: from,
    });

  const inbound = (trunkId: string, number = '+15551234567', query = '') =>
    dial(
      {
        'Caller-Destination-Number': number,
        'variable_sip_h_X-Call-Direction': 'inbound',
        'variable_sip_h_X-Trunk-Id': toContextId(trunkId),
      },
      query,
    );

  const apps = (xml: string) =>
    [
      ...xml.matchAll(
        /<action application="([^"]+)" data="([^"]*)"\/>|<action application="([^"]+)"\/>/g,
      ),
    ].map((m) => ({ app: m[1] ?? m[3] ?? '', data: (m[2] ?? '').replaceAll('&apos;', "'") }));

  describe('extension to extension', () => {
    it('with a record decision: writes to the spool and places the call after starting the recording', async () => {
      const tenantId = await seedTenant();
      const callee = await seedExtension(tenantId, '101');
      const caller = await seedExtension(tenantId, '100');
      fake.directive = record();

      const xml = await internal(tenantId);
      const list = apps(xml);
      expect(list).toContainEqual({
        app: 'set',
        data: `execute_on_answer=record_session ${SPOOL}/${RECORDING_ID}.wav`,
      });
      expect(list).toContainEqual({ app: 'set', data: `cuc_recording_id=${RECORDING_ID}` });
      expect(
        list.findIndex((a) => a.data.startsWith('execute_on_answer=record_session')),
      ).toBeLessThan(list.findIndex((a) => a.app === 'bridge'));
      expect(list.some((a) => a.app === 'playback')).toBe(false);

      // Asked with the call's real context: both extensions, direction, and the call uuid.
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]).toMatchObject({
        tenantId,
        direction: 'internal',
        callUuid: 'call-uuid-1',
      });
      expect([...fake.calls[0]!.extensionIds].sort()).toEqual([callee, caller].sort());
    });

    it('with a do-not-record decision: the document is exactly what it was without recording', async () => {
      const tenantId = await seedTenant();
      await seedExtension(tenantId, '101');
      fake.directive = { kind: 'none' };
      const withPolicy = await internal(tenantId);

      expect(withPolicy).not.toContain('record_session');
      expect(withPolicy).not.toContain('cuc_recording');
      expect(fake.calls).toHaveLength(1); // it was asked; the answer was no
    });

    it('with consent: plays the announcement (the tenant’s own asset) before recording begins', async () => {
      const tenantId = await seedTenant();
      await seedExtension(tenantId, '101');
      fake.directive = record({ announce: true, consentAssetId: 'asset-7' });

      const list = apps(await internal(tenantId));
      const names = list.map((a) => a.app);
      const playback = list.find((a) => a.app === 'playback')!;
      expect(playback.data).toBe(
        `http_cache://http://fs-node:${TOKEN}@telephony-config-test:8080/fs/media/${tenantId}/asset-7/8k.wav`,
      );
      expect(names.indexOf('pre_answer')).toBeLessThan(names.indexOf('playback'));
      const armed = list.findIndex((a) => a.data.startsWith('execute_on_answer=record_session'));
      expect(names.indexOf('playback')).toBeLessThan(armed);
      expect(armed).toBeLessThan(names.indexOf('bridge'));
    });

    it('with consent and no asset: plays the neutral tone', async () => {
      const tenantId = await seedTenant();
      await seedExtension(tenantId, '101');
      fake.directive = record({ announce: true, consentAssetId: null });
      const list = apps(await internal(tenantId));
      expect(list.find((a) => a.app === 'playback')?.data).toBe(CONSENT_TONE);
    });

    it('with the policy service unreachable: the call is still placed, unrecorded, and flagged', async () => {
      const tenantId = await seedTenant();
      await seedExtension(tenantId, '101');
      fake.directive = { kind: 'unavailable', reason: 'recording-service is down' };

      const xml = await internal(tenantId);
      const list = apps(xml);
      expect(list.some((a) => a.app === 'bridge')).toBe(true);
      expect(list).toContainEqual({ app: 'set', data: 'cuc_recording_status=unavailable' });
      expect(xml).not.toContain('record_session');
    });

    it('a real client against a dead service still returns a normal, bridged document', async () => {
      const tenantId = await seedTenant();
      await seedExtension(tenantId, '101');
      const dead = new Server0();
      const app2 = await createServer({ serviceName: 'telephony-config', logger: h.logger });
      registerFsRoutes(
        app2,
        h.db,
        h.readModel,
        TOKEN,
        'opensips:5060',
        h.logger,
        h.orgClient,
        h.pbxConfig,
        h.storage,
        h.voicemail,
        h.redis,
        h.callflow,
        h.affinity,
        h.callControl,
        'http://telephony-config-test:8080',
        {
          client: createRecordingClient({
            baseUrl: dead.url,
            internalServiceToken: 'x',
            logger: h.logger,
            timeoutMs: 200,
          }),
          spoolDir: SPOOL,
        },
      );
      await app2.ready();
      const response = await app2.inject({
        method: 'POST',
        url: '/fs/dialplan',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: BASIC_AUTH },
        payload: new URLSearchParams({
          section: 'dialplan',
          'Caller-Context': 'public',
          'Caller-Destination-Number': '101',
          'variable_sip_h_X-Call-Direction': 'internal',
          'variable_sip_h_X-Tenant-Id': tenantId,
          variable_sip_from_user: '100',
        }).toString(),
      });
      await app2.close();
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('sofia/internal/101@');
      expect(response.body).toContain('cuc_recording_status=unavailable');
      expect(response.body).not.toContain('record_session');
    });

    it('never asks about, or records, a number that is not a known extension or outbound route', async () => {
      const tenantId = await seedTenant();
      fake.directive = record();
      const xml = await internal(tenantId, '999');
      expect(xml).toContain('<result status="not found"/>');
      expect(fake.calls).toEqual([]);
    });
  });

  describe('outbound', () => {
    it('records with direction outbound and the calling extension', async () => {
      const tenantId = await seedTenant();
      const caller = await seedExtension(tenantId, '100');
      await seedOutbound(tenantId);
      h.orgClient.limits[tenantId] = { internationalAllowed: true };
      fake.directive = record();

      const xml = await internal(tenantId, '+14155552671');
      expect(fake.calls[0]).toMatchObject({
        tenantId,
        direction: 'outbound',
        extensionIds: [caller],
      });
      expect(apps(xml)).toContainEqual({
        app: 'set',
        data: `execute_on_answer=record_session ${SPOOL}/${RECORDING_ID}.wav`,
      });
      expect(xml).toContain('cuc_call_direction=outbound');
    });
  });

  describe('inbound from a trunk', () => {
    it('a DID to an extension: records with direction inbound, the DID and the extension', async () => {
      const tenantId = await seedTenant();
      const trunkId = await seedTrunk(tenantId);
      const extensionId = await seedExtension(tenantId, '102');
      const didId = crypto.randomUUID();
      await h.readModel.upsertDid(h.db.kysely, {
        id: didId,
        tenantId,
        e164: '+15551234567',
        trunkId,
        destinationType: 'extension',
        destinationId: extensionId,
      });
      fake.directive = record();

      const xml = await inbound(trunkId);
      expect(fake.calls[0]).toMatchObject({
        tenantId,
        direction: 'inbound',
        didId,
        extensionIds: [extensionId],
      });
      expect(fake.calls[0]?.queueId).toBeUndefined();
      expect(apps(xml).map((a) => a.app)).toContain('bridge');
      expect(xml).toContain('execute_on_answer=record_session');
    });

    it('a DID to a ring group: records with the DID', async () => {
      const tenantId = await seedTenant();
      const trunkId = await seedTrunk(tenantId);
      const ext1 = await seedExtension(tenantId, '101');
      const ext2 = await seedExtension(tenantId, '102');
      const groupId = crypto.randomUUID();
      await h.readModel.upsertRingGroup(h.db.kysely, {
        id: groupId,
        tenantId,
        label: 'Sales',
        strategy: 'simultaneous',
        memberExtensionIds: JSON.stringify([ext1, ext2]),
        ringTimeoutSeconds: 20,
        noAnswerDestinationType: null,
        noAnswerDestinationId: null,
      });
      const didId = crypto.randomUUID();
      await h.readModel.upsertDid(h.db.kysely, {
        id: didId,
        tenantId,
        e164: '+15551234567',
        trunkId,
        destinationType: 'ring_group',
        destinationId: groupId,
      });
      fake.directive = record();

      const xml = await inbound(trunkId);
      expect(fake.calls[0]).toMatchObject({ direction: 'inbound', didId });
      expect(xml).toContain('record_session');
    });

    it('a DID to a queue: records with the queue and the DID', async () => {
      const tenantId = await seedTenant();
      const trunkId = await seedTrunk(tenantId);
      const queueId = crypto.randomUUID();
      await h.readModel.upsertQueue(h.db.kysely, {
        id: queueId,
        tenantId,
        label: 'Support',
        strategy: 'round-robin',
        mohMediaAssetId: null,
        maxWaitSeconds: 0,
        announcePosition: false,
        announceFrequencySeconds: null,
        noAgentDestinationType: null,
        noAgentDestinationId: null,
      });
      const didId = crypto.randomUUID();
      await h.readModel.upsertDid(h.db.kysely, {
        id: didId,
        tenantId,
        e164: '+15551234567',
        trunkId,
        destinationType: 'queue',
        destinationId: queueId,
      });
      fake.directive = record();

      const xml = await inbound(trunkId, '+15551234567', '?nodeId=fs-1');
      expect(fake.calls[0]).toMatchObject({
        tenantId,
        direction: 'inbound',
        queueId,
        didId,
        nodeId: 'fs-1',
      });
      const list = apps(xml);
      const armed = list.findIndex((a) => a.data.startsWith('execute_on_answer=record_session'));
      expect(armed).toBeGreaterThanOrEqual(0);
      expect(armed).toBeLessThan(list.findIndex((a) => a.app === 'callcenter'));
    });

    it('a DID that is not the tenant’s or does not resolve is never asked about', async () => {
      const tenantId = await seedTenant();
      const trunkId = await seedTrunk(tenantId);
      fake.directive = record();
      const xml = await inbound(trunkId, '+15559999999');
      expect(xml).toContain('<result status="not found"/>');
      expect(fake.calls).toEqual([]);
    });
  });

  describe('calls through an IVR flow (S5-11)', () => {
    async function seedFlowDid(tenantId: string, trunkId: string): Promise<string> {
      const flowId = crypto.randomUUID();
      h.callflow.flows[`${tenantId}/${flowId}`] = {
        flowId,
        versionId: crypto.randomUUID(),
        versionNumber: 1,
        ir: {
          entryPoints: { main: 'bye' },
          nodes: { bye: { id: 'bye', type: 'hangup', config: {}, ports: {} } },
        },
      };
      const didId = crypto.randomUUID();
      await h.readModel.upsertDid(h.db.kysely, {
        id: didId,
        tenantId,
        e164: '+15551234567',
        trunkId,
        destinationType: 'flow',
        destinationId: flowId,
      });
      return didId;
    }

    async function seedQueue(tenantId: string): Promise<string> {
      const queueId = crypto.randomUUID();
      await h.readModel.upsertQueue(h.db.kysely, {
        id: queueId,
        tenantId,
        label: 'Support',
        strategy: 'round-robin',
        mohMediaAssetId: null,
        maxWaitSeconds: 0,
        announcePosition: false,
        announceFrequencySeconds: null,
        noAgentDestinationType: null,
        noAgentDestinationId: null,
      });
      return queueId;
    }

    const lookup = async (path: string) => {
      const response = await app.inject({
        method: 'GET',
        url: path,
        headers: { authorization: BASIC_AUTH },
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<Record<string, unknown>>();
    };

    it('flow entry: asks with the DID only, arms the recording before the flow answers, and passes the DID to the runner', async () => {
      const tenantId = await seedTenant();
      const trunkId = await seedTrunk(tenantId);
      const didId = await seedFlowDid(tenantId, trunkId);
      fake.directive = record();

      const xml = await inbound(trunkId);
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]).toMatchObject({ tenantId, direction: 'inbound', didId });
      expect(fake.calls[0]?.extensionIds).toEqual([]);
      expect(fake.calls[0]?.queueId).toBeUndefined();

      const list = apps(xml);
      const armed = list.findIndex((a) => a.data.startsWith('execute_on_answer=record_session'));
      expect(armed).toBeGreaterThanOrEqual(0);
      // Armed before `answer`, so the recording starts when the flow answers (IVR included).
      expect(armed).toBeLessThan(list.findIndex((a) => a.app === 'answer'));
      expect(list).toContainEqual({ app: 'set', data: `cuc_recording_id=${RECORDING_ID}` });
      expect(list).toContainEqual({ app: 'set', data: `cuc_did_id=${didId}` });
      expect(list.some((a) => a.app === 'lua' && a.data.startsWith('flow_runner.lua'))).toBe(true);
    });

    it('flow entry with no rule: the flow document is unchanged apart from the DID', async () => {
      const tenantId = await seedTenant();
      const trunkId = await seedTrunk(tenantId);
      await seedFlowDid(tenantId, trunkId);
      fake.directive = { kind: 'none' };

      const xml = await inbound(trunkId);
      expect(fake.calls).toHaveLength(1);
      expect(xml).not.toContain('record_session');
      expect(xml).not.toContain('cuc_recording');
    });

    it('hand-off to an extension: decides with the extension and the DID, and returns the instruction', async () => {
      const tenantId = await seedTenant();
      const extensionId = await seedExtension(tenantId, '401');
      const didId = crypto.randomUUID();
      fake.directive = record();

      const body = await lookup(
        `/fs/flow/${tenantId}/extension/${extensionId}?callUuid=flow-call-1&didId=${didId}&nodeId=fs-1&recording=0`,
      );
      expect(body).toEqual({
        number: '401',
        recording: {
          action: 'record',
          recordingId: RECORDING_ID,
          path: `${SPOOL}/${RECORDING_ID}.wav`,
          announcement: null,
        },
      });
      expect(fake.calls).toEqual([
        {
          tenantId,
          direction: 'inbound',
          extensionIds: [extensionId],
          didId,
          callUuid: 'flow-call-1',
          nodeId: 'fs-1',
        },
      ]);
    });

    it('hand-off with an announcement: names the tenant asset, or the neutral tone', async () => {
      const tenantId = await seedTenant();
      const extensionId = await seedExtension(tenantId, '401');
      const url = `/fs/flow/${tenantId}/extension/${extensionId}?callUuid=c&recording=0`;

      fake.directive = record({ announce: true, consentAssetId: 'asset-9' });
      expect((await lookup(url)).recording).toMatchObject({
        action: 'record',
        announcement: `http_cache://http://fs-node:${TOKEN}@telephony-config-test:8080/fs/media/${tenantId}/asset-9/8k.wav`,
      });

      fake.directive = record({ announce: true, consentAssetId: null });
      expect((await lookup(url)).recording).toMatchObject({ announcement: CONSENT_TONE });
    });

    it('hand-off while already recording: no decision, no second recording', async () => {
      const tenantId = await seedTenant();
      const extensionId = await seedExtension(tenantId, '401');
      fake.directive = record();

      const body = await lookup(
        `/fs/flow/${tenantId}/extension/${extensionId}?callUuid=c&recording=1`,
      );
      expect(body.recording).toEqual({ action: 'none' });
      expect(fake.calls).toEqual([]);
    });

    it('hand-off with no rule, or the service unreachable', async () => {
      const tenantId = await seedTenant();
      const extensionId = await seedExtension(tenantId, '401');
      const url = `/fs/flow/${tenantId}/extension/${extensionId}?callUuid=c&recording=0`;

      fake.directive = { kind: 'none' };
      expect((await lookup(url)).recording).toEqual({ action: 'none' });

      fake.directive = { kind: 'unavailable', reason: 'down' };
      expect((await lookup(url)).recording).toEqual({ action: 'unavailable' });
    });

    it('a runner that does not ask gets the plain lookup and nothing is decided', async () => {
      const tenantId = await seedTenant();
      const extensionId = await seedExtension(tenantId, '401');
      fake.directive = record();

      expect(await lookup(`/fs/flow/${tenantId}/extension/${extensionId}`)).toEqual({
        number: '401',
      });
      expect(fake.calls).toEqual([]);
    });

    it('hand-off to a ring group: decides with the DID (there is no ring-group scope)', async () => {
      const tenantId = await seedTenant();
      const ext1 = await seedExtension(tenantId, '101');
      const groupId = crypto.randomUUID();
      await h.readModel.upsertRingGroup(h.db.kysely, {
        id: groupId,
        tenantId,
        label: 'Sales',
        strategy: 'simultaneous',
        memberExtensionIds: JSON.stringify([ext1]),
        ringTimeoutSeconds: 20,
        noAnswerDestinationType: null,
        noAnswerDestinationId: null,
      });
      const didId = crypto.randomUUID();
      fake.directive = record();

      const body = await lookup(
        `/fs/flow/${tenantId}/ring-group/${groupId}?callUuid=c&didId=${didId}&recording=0`,
      );
      expect(body).toMatchObject({ numbers: ['101'], recording: { action: 'record' } });
      expect(fake.calls[0]).toMatchObject({ direction: 'inbound', didId, extensionIds: [] });
    });

    it('hand-off to a queue: decides with the queue and the DID, only when the queue is local', async () => {
      const tenantId = await seedTenant();
      const queueId = await seedQueue(tenantId);
      const didId = crypto.randomUUID();
      fake.directive = record();

      const body = await lookup(
        `/fs/flow/${tenantId}/queue/${queueId}?nodeId=fs-1&callUuid=c&didId=${didId}&recording=0`,
      );
      expect(body).toMatchObject({ isLocal: true, recording: { action: 'record' } });
      expect(fake.calls[0]).toMatchObject({ queueId, didId, nodeId: 'fs-1' });

      fake.calls = [];
      h.callControl.acquireResults[`${tenantId}:queue:${queueId}`] = {
        nodeId: 'fs-2',
        acquired: false,
      };
      const remote = await lookup(
        `/fs/flow/${tenantId}/queue/${queueId}?nodeId=fs-1&callUuid=c&recording=0`,
      );
      expect(remote).toMatchObject({ isLocal: false });
      expect(remote.recording).toBeUndefined();
      expect(fake.calls).toEqual([]);
      delete h.callControl.acquireResults[`${tenantId}:queue:${queueId}`];
    });
  });

  describe('recording required: fail closed (S5-12)', () => {
    const requireRecording = (tenantId: string, on = true) =>
      h.readModel.upsertRecordingFailClosed(h.db.kysely, tenantId, on);

    const expectRefused = (xml: string) => {
      const list = apps(xml);
      expect(list.map((a) => a.app)).toEqual(expect.arrayContaining(['pre_answer', 'playback']));
      expect(list).toContainEqual({ app: 'set', data: 'cuc_recording_status=refused' });
      expect(list.find((a) => a.app === 'playback')?.data).toBe(RECORDING_REFUSAL_TONE);
      expect(list.at(-1)).toEqual({ app: 'hangup', data: 'SERVICE_UNAVAILABLE' });
      // The tone comes before the hangup, and nothing places the call.
      const names = list.map((a) => a.app);
      expect(names.indexOf('pre_answer')).toBeLessThan(names.indexOf('playback'));
      expect(names).not.toContain('bridge');
      expect(names).not.toContain('lua');
      expect(xml).not.toContain('record_session');
    };

    it('an internal call is refused when the decision is unavailable and the tenant requires recording', async () => {
      const tenantId = await seedTenant();
      await seedExtension(tenantId, '101');
      await requireRecording(tenantId);
      fake.directive = { kind: 'unavailable', reason: 'recording-service is down' };

      const xml = await internal(tenantId);
      expectRefused(xml);
      expect(xml).toContain(`cuc_tenant_id=${tenantId}`);
      expect(xml).toContain('expression="^101$"');
    });

    it('an inbound DID call is refused the same way (SIP 503)', async () => {
      const tenantId = await seedTenant();
      const trunkId = await seedTrunk(tenantId);
      const extensionId = await seedExtension(tenantId, '102');
      await h.readModel.upsertDid(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        e164: '+15551234567',
        trunkId,
        destinationType: 'extension',
        destinationId: extensionId,
      });
      await requireRecording(tenantId);
      fake.directive = { kind: 'unavailable', reason: 'register failed' };

      expectRefused(await inbound(trunkId));
    });

    it('a decision of "no recording needed" is never refused', async () => {
      const tenantId = await seedTenant();
      await seedExtension(tenantId, '101');
      await requireRecording(tenantId);
      fake.directive = { kind: 'none' };

      const xml = await internal(tenantId);
      expect(apps(xml).map((a) => a.app)).toContain('bridge');
      expect(xml).not.toContain('cuc_recording_status');
    });

    it('a recorded call is placed and recorded as usual', async () => {
      const tenantId = await seedTenant();
      await seedExtension(tenantId, '101');
      await requireRecording(tenantId);
      fake.directive = record();

      const xml = await internal(tenantId);
      expect(apps(xml).map((a) => a.app)).toContain('bridge');
      expect(xml).toContain('execute_on_answer=record_session');
    });

    it('a tenant that does not require recording (or turned it off) still fails open', async () => {
      const tenantId = await seedTenant();
      await seedExtension(tenantId, '101');
      fake.directive = { kind: 'unavailable', reason: 'down' };
      expect(await internal(tenantId)).toContain('cuc_recording_status=unavailable');

      await requireRecording(tenantId, true);
      await requireRecording(tenantId, false);
      const xml = await internal(tenantId);
      expect(apps(xml).map((a) => a.app)).toContain('bridge');
      expect(xml).toContain('cuc_recording_status=unavailable');
    });

    it('a call into an IVR flow is refused at flow entry', async () => {
      const tenantId = await seedTenant();
      const trunkId = await seedTrunk(tenantId);
      const flowId = crypto.randomUUID();
      h.callflow.flows[`${tenantId}/${flowId}`] = {
        flowId,
        versionId: crypto.randomUUID(),
        versionNumber: 1,
        ir: {
          entryPoints: { main: 'bye' },
          nodes: { bye: { id: 'bye', type: 'hangup', config: {}, ports: {} } },
        },
      };
      await h.readModel.upsertDid(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        e164: '+15551234567',
        trunkId,
        destinationType: 'flow',
        destinationId: flowId,
      });
      await requireRecording(tenantId);
      fake.directive = { kind: 'unavailable', reason: 'down' };

      expectRefused(await inbound(trunkId));
    });

    it('a flow hand-off tells the runner to refuse the call', async () => {
      const tenantId = await seedTenant();
      const extensionId = await seedExtension(tenantId, '401');
      await requireRecording(tenantId);
      fake.directive = { kind: 'unavailable', reason: 'down' };

      const response = await app.inject({
        method: 'GET',
        url: `/fs/flow/${tenantId}/extension/${extensionId}?callUuid=c&recording=0`,
        headers: { authorization: BASIC_AUTH },
      });
      expect(response.json<{ recording: unknown }>().recording).toEqual({
        action: 'refuse',
        tone: RECORDING_REFUSAL_TONE,
        cause: 'SERVICE_UNAVAILABLE',
      });
    });

    it('with a real client against a dead recording-service, the flag alone refuses the call', async () => {
      const tenantId = await seedTenant();
      await seedExtension(tenantId, '101');
      await requireRecording(tenantId);
      const app2 = await createServer({ serviceName: 'telephony-config', logger: h.logger });
      registerFsRoutes(
        app2,
        h.db,
        h.readModel,
        TOKEN,
        'opensips:5060',
        h.logger,
        h.orgClient,
        h.pbxConfig,
        h.storage,
        h.voicemail,
        h.redis,
        h.callflow,
        h.affinity,
        h.callControl,
        'http://telephony-config-test:8080',
        {
          client: createRecordingClient({
            baseUrl: new Server0().url,
            internalServiceToken: 'x',
            logger: h.logger,
            timeoutMs: 200,
          }),
          spoolDir: SPOOL,
        },
      );
      await app2.ready();
      const response = await app2.inject({
        method: 'POST',
        url: '/fs/dialplan',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: BASIC_AUTH },
        payload: new URLSearchParams({
          section: 'dialplan',
          'Caller-Context': 'public',
          'Caller-Destination-Number': '101',
          'variable_sip_h_X-Call-Direction': 'internal',
          'variable_sip_h_X-Tenant-Id': tenantId,
          variable_sip_from_user: '100',
        }).toString(),
      });
      await app2.close();
      expectRefused(response.body);
    });
  });

  describe('feature codes: on demand and pause (S5-13)', () => {
    const bindings = (xml: string) =>
      apps(xml)
        .filter((a) => a.app === 'bind_meta_app')
        .map((a) => a.data);
    const contextOf = (xml: string) => {
      const set = apps(xml).find((a) => a.app === 'set' && a.data.startsWith('cuc_rec_ctx='));
      return set === undefined ? undefined : decodeRecordingContext(set.data.slice(12));
    };

    it('a rule that allows on demand arms *1 and *2 on an unrecorded internal call, for both parties', async () => {
      const tenantId = await seedTenant();
      const callee = await seedExtension(tenantId, '101');
      const caller = await seedExtension(tenantId, '100');
      fake.directive = { kind: 'none', allowOnDemand: true };

      const xml = await internal(tenantId);
      expect(bindings(xml)).toEqual([
        '1 ab s lua::recording_control.lua record',
        '2 ab s lua::recording_control.lua pause',
      ]);
      const list = apps(xml);
      expect(list).toContainEqual({ app: 'export', data: 'cuc_rec_owner=${uuid}' });
      expect(list).toContainEqual({ app: 'set', data: 'RECORD_STEREO=true' });
      expect(xml).not.toContain('record_session');
      // Armed before the call is placed.
      expect(list.findIndex((a) => a.app === 'bind_meta_app')).toBeLessThan(
        list.findIndex((a) => a.app === 'bridge'),
      );
      const context = contextOf(xml);
      expect(context).toMatchObject({ tenantId, direction: 'internal' });
      expect([...(context?.extensionIds ?? [])].sort()).toEqual([callee, caller].sort());
    });

    it('a recorded inbound call arms them for the called party (the B leg) only', async () => {
      const tenantId = await seedTenant();
      const trunkId = await seedTrunk(tenantId);
      const extensionId = await seedExtension(tenantId, '102');
      const didId = crypto.randomUUID();
      await h.readModel.upsertDid(h.db.kysely, {
        id: didId,
        tenantId,
        e164: '+15551234567',
        trunkId,
        destinationType: 'extension',
        destinationId: extensionId,
      });
      fake.directive = { ...record(), allowOnDemand: true };

      const xml = await inbound(trunkId);
      expect(bindings(xml)).toEqual([
        '1 b s lua::recording_control.lua record',
        '2 b s lua::recording_control.lua pause',
      ]);
      expect(xml).toContain('execute_on_answer=record_session');
      expect(contextOf(xml)).toEqual({
        tenantId,
        direction: 'inbound',
        extensionIds: [extensionId],
        didId,
      });
    });

    it('an outbound call arms them for the caller (the A leg)', async () => {
      const tenantId = await seedTenant();
      await seedExtension(tenantId, '100');
      await seedOutbound(tenantId);
      h.orgClient.limits[tenantId] = { internationalAllowed: true };
      fake.directive = { kind: 'none', allowOnDemand: true };

      const xml = await internal(tenantId, '+14155552671');
      expect(bindings(xml)[0]).toBe('1 a s lua::recording_control.lua record');
    });

    it('no codes without a rule that allows them, or when the decision is unavailable', async () => {
      const tenantId = await seedTenant();
      await seedExtension(tenantId, '101');
      fake.directive = { kind: 'none' };
      expect(bindings(await internal(tenantId))).toEqual([]);
      fake.directive = record();
      expect(bindings(await internal(tenantId))).toEqual([]);
      fake.directive = { kind: 'unavailable', reason: 'down' };
      expect(bindings(await internal(tenantId))).toEqual([]);
    });

    it('a flow hand-off returns the codes for the runner to arm', async () => {
      const tenantId = await seedTenant();
      const extensionId = await seedExtension(tenantId, '401');
      const didId = crypto.randomUUID();
      fake.directive = { kind: 'none', allowOnDemand: true };

      const response = await app.inject({
        method: 'GET',
        url: `/fs/flow/${tenantId}/extension/${extensionId}?callUuid=c&didId=${didId}&recording=0`,
        headers: { authorization: BASIC_AUTH },
      });
      const body = response.json<{
        recording: { action: string; featureCodes: { listen: string; context: string } };
      }>();
      expect(body.recording.action).toBe('none');
      expect(body.recording.featureCodes.listen).toBe('b');
      expect(decodeRecordingContext(body.recording.featureCodes.context)).toEqual({
        tenantId,
        direction: 'inbound',
        extensionIds: [extensionId],
        didId,
      });
    });

    describe('/fs/recording/:tenantId/control', () => {
      async function press(tenantId: string, body: Record<string, unknown>) {
        const response = await app.inject({
          method: 'POST',
          url: `/fs/recording/${tenantId}/control`,
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'x-fs-node-token': TOKEN,
          },
          // mod_curl labels its JSON body form-urlencoded; the parser sniffs it.
          payload: JSON.stringify(body),
        });
        return response;
      }

      async function armedContext(tenantId: string): Promise<string> {
        await seedExtension(tenantId, '101');
        fake.directive = { kind: 'none', allowOnDemand: true };
        const xml = await internal(tenantId);
        return apps(xml)
          .find((a) => a.data.startsWith('cuc_rec_ctx='))!
          .data.slice('cuc_rec_ctx='.length);
      }

      it('relays *1 with the call context and tells the node to start, on the spool path', async () => {
        const tenantId = await seedTenant();
        const context = await armedContext(tenantId);
        fake.controlResult = {
          result: 'started',
          recordingId: RECORDING_ID,
          fileName: `${RECORDING_ID}.wav`,
          reason: null,
        };

        const response = await press(tenantId, {
          code: 'record',
          callUuid: 'owner-uuid',
          context,
          nodeId: 'fs-1',
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual({
          action: 'start',
          recordingId: RECORDING_ID,
          path: `${SPOOL}/${RECORDING_ID}.wav`,
          tone: FEATURE_CODE_DONE_TONE,
        });
        expect(fake.controlCalls).toHaveLength(1);
        expect(fake.controlCalls[0]).toMatchObject({
          tenantId,
          code: 'record',
          callUuid: 'owner-uuid',
          nodeId: 'fs-1',
          context: { direction: 'internal' },
        });
        expect(fake.controlCalls[0]?.recordingId).toBeUndefined();
      });

      it('maps stop, pause and resume to uuid_record stop, mask and unmask', async () => {
        const tenantId = await seedTenant();
        const context = await armedContext(tenantId);
        for (const [result, action] of [
          ['stopped', 'stop'],
          ['paused', 'mask'],
          ['resumed', 'unmask'],
        ] as const) {
          fake.controlResult = {
            result,
            recordingId: RECORDING_ID,
            fileName: `${RECORDING_ID}.wav`,
            reason: null,
          };
          const response = await press(tenantId, {
            code: 'pause',
            callUuid: 'o',
            recordingId: RECORDING_ID,
            context,
          });
          expect(response.json()).toMatchObject({ action, path: `${SPOOL}/${RECORDING_ID}.wav` });
        }
        expect(fake.controlCalls.at(-1)?.recordingId).toBe(RECORDING_ID);
      });

      it('a refusal, an unreachable recording-service, or a foreign context does nothing', async () => {
        const tenantId = await seedTenant();
        const context = await armedContext(tenantId);

        expect((await press(tenantId, { code: 'record', callUuid: 'o', context })).json()).toEqual({
          action: 'none',
          reason: 'not_allowed',
          tone: FEATURE_CODE_REFUSED_TONE,
        });

        fake.controlResult = new Error('down');
        expect(
          (await press(tenantId, { code: 'record', callUuid: 'o', context })).json(),
        ).toMatchObject({ action: 'none', reason: 'unavailable' });

        const calls = fake.controlCalls.length;
        const other = crypto.randomUUID();
        expect(
          (await press(other, { code: 'record', callUuid: 'o', context })).json(),
        ).toMatchObject({ action: 'none', reason: 'no_context' });
        expect(
          (await press(tenantId, { code: 'record', callUuid: 'o', context: 'garbage' })).json(),
        ).toMatchObject({ action: 'none', reason: 'no_context' });
        expect(fake.controlCalls).toHaveLength(calls);
      });

      it('needs the node token', async () => {
        const response = await app.inject({
          method: 'POST',
          url: `/fs/recording/${crypto.randomUUID()}/control`,
          headers: { 'content-type': 'application/json' },
          payload: { code: 'record', callUuid: 'o', context: 'x' },
        });
        expect(response.statusCode).toBe(401);
      });
    });
  });

  describe('agent-scoped rules for queue calls (S5-14)', () => {
    async function seedQueue(tenantId: string): Promise<string> {
      const queueId = crypto.randomUUID();
      await h.readModel.upsertQueue(h.db.kysely, {
        id: queueId,
        tenantId,
        label: 'Support',
        strategy: 'round-robin',
        mohMediaAssetId: null,
        maxWaitSeconds: 0,
        announcePosition: false,
        announceFrequencySeconds: null,
        noAgentDestinationType: null,
        noAgentDestinationId: null,
      });
      return queueId;
    }

    it('a DID to a queue arms the agent-answer decision after answer, before the queue', async () => {
      const tenantId = await seedTenant();
      const trunkId = await seedTrunk(tenantId);
      const queueId = await seedQueue(tenantId);
      const didId = crypto.randomUUID();
      await h.readModel.upsertDid(h.db.kysely, {
        id: didId,
        tenantId,
        e164: '+15551234567',
        trunkId,
        destinationType: 'queue',
        destinationId: queueId,
      });
      fake.directive = { kind: 'none' };

      const list = apps(await inbound(trunkId, '+15551234567', '?nodeId=fs-1'));
      const names = list.map((a) => a.app);
      expect(list).toContainEqual({ app: 'set', data: `cuc_queue_id=${queueId}` });
      expect(list).toContainEqual({ app: 'set', data: `cuc_did_id=${didId}` });
      expect(list).toContainEqual({ app: 'set', data: 'cuc_queue_member_uuid=${uuid}' });
      const armed = list.findIndex(
        (a) => a.data === 'execute_on_answer_cuc_agent=lua agent_recording.lua',
      );
      const exported = list.findIndex(
        (a) =>
          a.data ===
          'cc_export_vars=cuc_tenant_id,cuc_queue_id,cuc_did_id,cuc_queue_member_uuid,execute_on_answer_cuc_agent',
      );
      // After the caller's own answer (so it never runs on the caller), before the queue.
      expect(armed).toBeGreaterThan(names.indexOf('answer'));
      expect(exported).toBeGreaterThan(names.indexOf('answer'));
      expect(armed).toBeLessThan(names.indexOf('callcenter'));
      expect(exported).toBeLessThan(names.indexOf('callcenter'));
    });

    describe('/fs/recording/:tenantId/agent-answer', () => {
      const answer = (tenantId: string, query: string) =>
        app.inject({
          method: 'GET',
          url: `/fs/recording/${tenantId}/agent-answer?${query}`,
          headers: { 'x-fs-node-token': TOKEN },
        });

      it('decides with the answering agent and records the agent’s leg', async () => {
        const tenantId = await seedTenant();
        const agentExtension = await seedExtension(tenantId, '301');
        const queueId = await seedQueue(tenantId);
        fake.directive = record();

        const response = await answer(
          tenantId,
          `queueId=${queueId}&agent=301@${DOMAIN}&callUuid=member-1&nodeId=fs-1&didId=D1`,
        );
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual({
          action: 'record',
          recordingId: RECORDING_ID,
          path: `${SPOOL}/${RECORDING_ID}.wav`,
        });
        expect(fake.calls).toEqual([
          {
            tenantId,
            direction: 'inbound',
            extensionIds: [],
            queueId,
            didId: 'D1',
            agentId: agentExtension,
            callUuid: 'member-1',
            nodeId: 'fs-1',
          },
        ]);
      });

      it('no rule, or recording-service unreachable: nothing, and never a refusal (S5-12 does not apply here)', async () => {
        const tenantId = await seedTenant();
        await seedExtension(tenantId, '301');
        const queueId = await seedQueue(tenantId);
        await h.readModel.upsertRecordingFailClosed(h.db.kysely, tenantId, true);
        const query = `queueId=${queueId}&agent=301@${DOMAIN}&callUuid=m`;

        fake.directive = { kind: 'none' };
        expect((await answer(tenantId, query)).json()).toEqual({ action: 'none' });
        fake.directive = { kind: 'unavailable', reason: 'down' };
        expect((await answer(tenantId, query)).json()).toEqual({ action: 'none' });
      });

      it('an agent or queue outside the tenant is never decided', async () => {
        const tenantId = await seedTenant();
        await seedExtension(tenantId, '301');
        const queueId = await seedQueue(tenantId);
        const otherTenant = crypto.randomUUID();
        await h.readModel.upsertTenant(h.db.kysely, { id: otherTenant, status: 'active' });
        await h.readModel.upsertDomain(h.db.kysely, {
          id: crypto.randomUUID(),
          tenantId: otherTenant,
          fqdn: 'other.platform.test',
        });
        const otherQueue = await seedQueue(otherTenant);
        fake.directive = record();

        for (const query of [
          `queueId=${queueId}&agent=301@other.platform.test&callUuid=m`,
          `queueId=${queueId}&agent=999@${DOMAIN}&callUuid=m`,
          `queueId=${otherQueue}&agent=301@${DOMAIN}&callUuid=m`,
          `queueId=${queueId}&agent=nodomain&callUuid=m`,
        ]) {
          expect((await answer(tenantId, query)).json(), query).toEqual({ action: 'none' });
        }
        expect(fake.calls).toEqual([]);
      });

      it('needs the node token', async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/fs/recording/${crypto.randomUUID()}/agent-answer?queueId=q&agent=1@x&callUuid=m`,
        });
        expect(response.statusCode).toBe(401);
      });
    });
  });

  describe('calls that are never recorded here', () => {
    it('voicemail retrieval, agent login and DIDs to voicemail are not offered for recording', async () => {
      const tenantId = await seedTenant();
      await seedExtension(tenantId, '100');
      fake.directive = record();
      await internal(tenantId, '*97');
      await internal(tenantId, '*45');

      const trunkId = await seedTrunk(tenantId);
      await h.readModel.upsertDid(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        e164: '+15551230000',
        trunkId,
        destinationType: 'voicemail',
        destinationId: crypto.randomUUID(),
      });
      const xml = await inbound(trunkId, '+15551230000');
      expect(xml).not.toContain('record_session');
      expect(fake.calls).toEqual([]);
    });

    it('emergency calls are never recorded by policy', async () => {
      const tenantId = await seedTenant();
      await seedExtension(tenantId, '100');
      await h.readModel.upsertEmergencyRoute(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        trunkId: await seedTrunk(tenantId),
        numbers: ['911'],
      });
      fake.directive = record();
      const xml = await internal(tenantId, '911');
      expect(xml).not.toContain('record_session');
      expect(fake.calls).toEqual([]);
    });
  });

  it('with recording not wired (null), dialplan is unchanged and nothing is asked', async () => {
    const tenantId = await seedTenant();
    await seedExtension(tenantId, '101');
    const off = await createServer({ serviceName: 'telephony-config', logger: h.logger });
    registerFsRoutes(
      off,
      h.db,
      h.readModel,
      TOKEN,
      'opensips:5060',
      h.logger,
      h.orgClient,
      h.pbxConfig,
      h.storage,
      h.voicemail,
      h.redis,
      h.callflow,
      h.affinity,
      h.callControl,
      'http://telephony-config-test:8080',
    );
    await off.ready();
    const response = await off.inject({
      method: 'POST',
      url: '/fs/dialplan',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: BASIC_AUTH },
      payload: new URLSearchParams({
        section: 'dialplan',
        'Caller-Context': 'public',
        'Caller-Destination-Number': '101',
        'variable_sip_h_X-Call-Direction': 'internal',
        'variable_sip_h_X-Tenant-Id': tenantId,
        variable_sip_from_user: '100',
      }).toString(),
    });
    await off.close();
    expect(response.body).not.toContain('record_session');
  });
});

/** A URL nothing listens on. */
class Server0 {
  readonly url = 'http://127.0.0.1:1';
}
