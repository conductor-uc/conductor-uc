import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, redisOrSkipReason } from '@cuc/testing';
import { createServer, type Server } from '@cuc/http';

import { toContextId } from '../src/context-id.js';
import {
  createRecordingClient,
  type RecordingCall,
  type RecordingClient,
  type RecordingDirective,
} from '../src/recording-client.js';
import { registerFsRoutes } from '../src/routes/fs.routes.js';
import { CONSENT_TONE } from '../src/xml.js';
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
