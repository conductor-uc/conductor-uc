import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';

import type { ValidPolicy } from '../src/domain/policy.js';
import {
  INTERNAL_TOKEN,
  resetSchema,
  startHarness,
  startRoutes,
  TENANT_ADMIN_ROLE,
  type Harness,
  type RoutesHarness,
} from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());

interface ControlResult {
  result: 'started' | 'stopped' | 'paused' | 'resumed' | 'refused';
  recordingId: string | null;
  fileName: string | null;
  reason: string | null;
}

/**
 * S5-13 (G-111): feature codes during a call, relayed by telephony-config. Every change is decided
 * here with the call's policies and is audited in the same transaction as the change.
 */
describe.skipIf(skipReason !== undefined)('recording feature codes (S5-13)', () => {
  let h: Harness;
  let r: RoutesHarness;
  const tenantId = 'tenant-a';
  const context = { direction: 'inbound' as const, extensionIds: ['E1'], didId: 'D1' };

  beforeAll(async () => {
    h = await startHarness();
    r = await startRoutes(h);
  });
  afterAll(async () => {
    await r?.app.close();
    await h?.close();
  });
  afterEach(async () => {
    await resetSchema(h.db);
  });

  const rule = (overrides: Partial<ValidPolicy> = {}): Promise<unknown> =>
    h.policies.create(
      { tenantId },
      {
        scopeType: 'extension',
        scopeId: 'E1',
        direction: 'any',
        action: 'no_record',
        announce: false,
        consentAssetId: null,
        allowOnDemand: true,
        ...overrides,
      },
    );

  const control = async (body: Record<string, unknown>, token = INTERNAL_TOKEN) =>
    r.app.inject({
      method: 'POST',
      url: '/internal/v1/recordings/control',
      headers: { authorization: `Bearer ${token}` },
      payload: { tenantId, callUuid: 'call-1', nodeId: 'fs-1', context, ...body },
    });

  const press = async (body: Record<string, unknown>): Promise<ControlResult> => {
    const response = await control(body);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<ControlResult>();
  };

  async function auditRows(): Promise<Record<string, unknown>[]> {
    const rows = await h.db.kysely
      .selectFrom('outbox')
      .select(['type', 'payload'])
      .where('type', '=', 'audit.event.recorded')
      .orderBy('created_at')
      .execute();
    return rows.map(
      (row) =>
        (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as Record<
          string,
          unknown
        >,
    );
  }

  async function audits(): Promise<{ action: string; actorType: string; dataClass: string }[]> {
    const rows = await h.db.kysely
      .selectFrom('outbox')
      .select(['type', 'payload'])
      .where('type', '=', 'audit.event.recorded')
      .orderBy('created_at')
      .execute();
    return rows.map((row) => {
      const data = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as {
        action: string;
        actorType: string;
        dataClass: string;
      };
      return { action: data.action, actorType: data.actorType, dataClass: data.dataClass };
    });
  }

  it('needs the internal token', async () => {
    expect((await control({ code: 'record' }, 'wrong')).statusCode).toBe(401);
  });

  it('*1 starts an on-demand recording where a rule allows it, and *1 again stops it; both audited', async () => {
    await rule();

    const started = await press({ code: 'record' });
    expect(started).toMatchObject({ result: 'started', reason: null });
    expect(started.fileName).toBe(`${started.recordingId!}.wav`);
    const row = await h.recordings.findById({ tenantId }, started.recordingId!);
    expect(row).toMatchObject({
      onDemand: true,
      status: 'pending',
      callUuid: 'call-1',
      extensionId: 'E1',
      didId: 'D1',
      direction: 'inbound',
      nodeId: 'fs-1',
      stoppedAt: null,
    });

    const stopped = await press({ code: 'record', recordingId: started.recordingId });
    expect(stopped).toMatchObject({ result: 'stopped', recordingId: started.recordingId });
    const after = await h.recordings.findById({ tenantId }, started.recordingId!);
    expect(after?.stoppedAt).toBeInstanceOf(Date);

    expect(await audits()).toEqual([
      { action: 'recording.on_demand.started', actorType: 'node', dataClass: 'private' },
      { action: 'recording.on_demand.stopped', actorType: 'node', dataClass: 'private' },
    ]);

    // After a stop, *1 starts a new, separate recording.
    const again = await press({ code: 'record', recordingId: started.recordingId });
    expect(again.result).toBe('started');
    expect(again.recordingId).not.toBe(started.recordingId);
  });

  it('*1 is refused without a rule that allows it, and nothing is registered or audited', async () => {
    expect(await press({ code: 'record' })).toMatchObject({
      result: 'refused',
      reason: 'not_allowed',
    });
    await rule({ allowOnDemand: false });
    expect((await press({ code: 'record' })).reason).toBe('not_allowed');
    expect(await h.db.kysely.selectFrom('recordings').selectAll().execute()).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  it('*1 never stops a recording a rule started', async () => {
    await rule({ action: 'record' });
    const ruled = await h.recordings.register(
      { tenantId },
      { callUuid: 'call-1', direction: 'inbound', extensionId: 'E1', announced: false },
    );
    expect(await press({ code: 'record', recordingId: ruled.id })).toMatchObject({
      result: 'refused',
      reason: 'rule_recording',
    });
    expect(await audits()).toEqual([]);
  });

  it('*2 pauses and resumes a rule recording where the rule allows it, keeping the intervals', async () => {
    await rule({ action: 'record' });
    const ruled = await h.recordings.register(
      { tenantId },
      { callUuid: 'call-1', direction: 'inbound', extensionId: 'E1', announced: false },
    );

    expect(await press({ code: 'pause', recordingId: ruled.id })).toMatchObject({
      result: 'paused',
      fileName: `${ruled.id}.wav`,
    });
    let row = await h.recordings.findById({ tenantId }, ruled.id);
    expect(row?.pauses).toHaveLength(1);
    expect(row?.pauses[0]?.to).toBeNull();

    expect((await press({ code: 'pause', recordingId: ruled.id })).result).toBe('resumed');
    row = await h.recordings.findById({ tenantId }, ruled.id);
    expect(row?.pauses[0]?.to).toBeInstanceOf(Date);

    expect((await press({ code: 'pause', recordingId: ruled.id })).result).toBe('paused');
    row = await h.recordings.findById({ tenantId }, ruled.id);
    expect(row?.pauses).toHaveLength(2);

    expect((await audits()).map((a) => a.action)).toEqual([
      'recording.paused',
      'recording.resumed',
      'recording.paused',
    ]);
  });

  it('*2 is refused on a rule recording whose rule does not allow it, and when nothing is recording', async () => {
    await rule({ action: 'record', allowOnDemand: false });
    const ruled = await h.recordings.register(
      { tenantId },
      { callUuid: 'call-1', direction: 'inbound', extensionId: 'E1', announced: false },
    );
    expect((await press({ code: 'pause', recordingId: ruled.id })).reason).toBe('not_allowed');
    expect((await press({ code: 'pause' })).reason).toBe('not_recording');
    expect(await audits()).toEqual([]);
  });

  it('*2 pauses an on-demand recording, and stopping it closes the pause', async () => {
    await rule();
    const started = await press({ code: 'record' });
    expect((await press({ code: 'pause', recordingId: started.recordingId })).result).toBe(
      'paused',
    );
    await press({ code: 'record', recordingId: started.recordingId });
    const row = await h.recordings.findById({ tenantId }, started.recordingId!);
    expect(row?.pauses[0]?.to).toBeInstanceOf(Date);
    expect((await press({ code: 'pause', recordingId: started.recordingId })).reason).toBe(
      'stopped',
    );
  });

  it('a recording of another call or another tenant is unknown here', async () => {
    await rule({ action: 'record' });
    const other = await h.recordings.register(
      { tenantId },
      { callUuid: 'call-2', direction: 'inbound', extensionId: 'E1', announced: false },
    );
    const elsewhere = await h.recordings.register(
      { tenantId: 'tenant-b' },
      { callUuid: 'call-1', direction: 'inbound', extensionId: 'E1', announced: false },
    );
    expect((await press({ code: 'pause', recordingId: other.id })).reason).toBe(
      'unknown_recording',
    );
    expect((await press({ code: 'pause', recordingId: elsewhere.id })).reason).toBe(
      'unknown_recording',
    );
    expect((await press({ code: 'pause', recordingId: 'not-a-uuid' })).reason).toBe(
      'unknown_recording',
    );
  });

  it('the recordings API shows on-demand recordings and their pauses', async () => {
    await rule();
    const started = await press({ code: 'record' });
    await press({ code: 'pause', recordingId: started.recordingId });
    r.access.set('admin', { roles: [TENANT_ADMIN_ROLE] });
    const response = await r.app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/recordings?status=pending`,
      headers: r.headers('admin', tenantId),
    });
    expect(response.statusCode, response.body).toBe(200);
    const [row] = response.json<{
      rows: { onDemand: boolean; stoppedAt: string | null; pauses: { from: string; to: null }[] }[];
    }>().rows;
    expect(row?.onDemand).toBe(true);
    expect(row?.stoppedAt).toBeNull();
    expect(row?.pauses).toHaveLength(1);
    expect(Number.isNaN(Date.parse(row?.pauses[0]?.from ?? ''))).toBe(false);
    expect(row?.pauses[0]?.to).toBeNull();
  });

  describe('explicit actions from the console (S5-15)', () => {
    const person = { id: 'user-7', orgId: tenantId };
    const act = (body: Record<string, unknown>) =>
      press({ actor: person, ip: '203.0.113.9', requestId: 'req-1', ...body });

    it('needs exactly one of code and action', async () => {
      expect((await control({})).statusCode).toBe(400);
      expect((await control({ code: 'record', action: 'start' })).statusCode).toBe(400);
    });

    it('start and stop an on-demand recording, audited as the person who asked', async () => {
      await rule();
      const started = await act({ action: 'start' });
      expect(started.result).toBe('started');
      const stopped = await act({ action: 'stop', recordingId: started.recordingId });
      expect(stopped).toMatchObject({ result: 'stopped', recordingId: started.recordingId });

      const rows = await auditRows();
      expect(rows.map((a) => a['action'])).toEqual([
        'recording.on_demand.started',
        'recording.on_demand.stopped',
      ]);
      for (const row of rows) {
        expect(row).toMatchObject({
          actorType: 'user',
          actorId: 'user-7',
          actorOrgId: tenantId,
          targetOrgId: tenantId,
          dataClass: 'private',
          resource: `recording:${started.recordingId!}`,
          ip: '203.0.113.9',
          requestId: 'req-1',
        });
      }
    });

    it('does not toggle: start while recording, stop while not, are refused and not audited', async () => {
      await rule();
      expect((await act({ action: 'stop' })).reason).toBe('not_recording');
      const started = await act({ action: 'start' });
      expect((await act({ action: 'start', recordingId: started.recordingId })).reason).toBe(
        'already_recording',
      );
      // A second Start that raced the first (the channel has no id yet) is refused too.
      expect((await act({ action: 'start' })).reason).toBe('already_recording');
      expect((await auditRows()).map((a) => a['action'])).toEqual(['recording.on_demand.started']);
    });

    it('never stops a rule recording, and never starts a second recording over it', async () => {
      await rule({ action: 'record' });
      const ruled = await h.recordings.register(
        { tenantId },
        { callUuid: 'call-1', direction: 'inbound', extensionId: 'E1', announced: false },
      );
      expect((await act({ action: 'stop', recordingId: ruled.id })).reason).toBe('rule_recording');
      expect((await act({ action: 'start', recordingId: ruled.id })).reason).toBe(
        'already_recording',
      );
      expect(await auditRows()).toEqual([]);
    });

    it('pause and resume are explicit: a second pause is refused rather than resuming', async () => {
      await rule({ action: 'record' });
      const ruled = await h.recordings.register(
        { tenantId },
        { callUuid: 'call-1', direction: 'inbound', extensionId: 'E1', announced: false },
      );
      expect((await act({ action: 'resume', recordingId: ruled.id })).reason).toBe('not_paused');
      expect((await act({ action: 'pause', recordingId: ruled.id })).result).toBe('paused');
      expect((await act({ action: 'pause', recordingId: ruled.id })).reason).toBe('already_paused');
      expect((await act({ action: 'resume', recordingId: ruled.id })).result).toBe('resumed');
      const row = await h.recordings.findById({ tenantId }, ruled.id);
      expect(row?.pauses).toHaveLength(1);
      expect(row?.pauses[0]?.to).toBeInstanceOf(Date);
      expect((await auditRows()).map((a) => [a['action'], a['actorType']])).toEqual([
        ['recording.paused', 'user'],
        ['recording.resumed', 'user'],
      ]);
    });

    it('the same rules as the codes: no start and no pause where no rule allows on demand', async () => {
      await rule({ action: 'record', allowOnDemand: false });
      const ruled = await h.recordings.register(
        { tenantId },
        { callUuid: 'call-1', direction: 'inbound', extensionId: 'E1', announced: false },
      );
      expect((await act({ action: 'pause', recordingId: ruled.id })).reason).toBe('not_allowed');
      await resetSchema(h.db);
      await rule({ allowOnDemand: false });
      expect((await act({ action: 'start' })).reason).toBe('not_allowed');
      expect(await h.db.kysely.selectFrom('recordings').selectAll().execute()).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });
  });
});
