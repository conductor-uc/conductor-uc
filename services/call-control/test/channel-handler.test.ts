import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, redisOrSkipReason } from '@cuc/testing';

import { createChannelHandler } from '../src/channel-handler.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await redisOrSkipReason());

/** MariaDB's `json` column type comes back already parsed via mysql2; a string only if some other driver is ever used. */
function parsePayload(payload: unknown): Record<string, unknown> {
  return typeof payload === 'string'
    ? (JSON.parse(payload) as Record<string, unknown>)
    : (payload as Record<string, unknown>);
}

describe.skipIf(skipReason !== undefined)(
  'channel handler (ESL event -> outbox + Redis registry)',
  () => {
    let h: Harness;

    beforeAll(async () => {
      h = await startHarness();
    });

    afterAll(async () => {
      await h?.close();
    });

    afterEach(async () => {
      await resetSchema(h.db);
    });

    it('CHANNEL_CREATE enqueues call.channel.created and writes the Redis call record', async () => {
      const handler = createChannelHandler({
        db: h.db.kysely,
        registry: h.registry,
        logger: h.logger,
        callSafetyTtlMs: 6 * 60 * 60 * 1000,
        heartbeatTtlMs: 10_000,
      });
      const callUuid = crypto.randomUUID();
      const tenantId = crypto.randomUUID();

      await handler.handleEvent('fs-1', {
        'Event-Name': 'CHANNEL_CREATE',
        'Unique-ID': callUuid,
        'Call-Direction': 'inbound',
        'Caller-Caller-ID-Number': '+15550001111',
        'Caller-Destination-Number': '1001',
        'variable_sip_h_X-Tenant-Id': tenantId,
      });

      const outboxRow = await h.db.kysely
        .selectFrom('outbox')
        .selectAll()
        .where('type', '=', 'call.channel.created')
        .executeTakeFirst();
      expect(outboxRow).toBeDefined();
      expect(outboxRow?.tenant_id).toBe(tenantId);
      expect(parsePayload(outboxRow?.payload)).toMatchObject({
        callUuid,
        nodeId: 'fs-1',
        tenantId,
        direction: 'inbound',
        from: '+15550001111',
        to: '1001',
      });

      const record = await h.registry.getCall(callUuid);
      expect(record).toMatchObject({ node: 'fs-1', tenant: tenantId, state: 'ringing' });
    });

    it('CHANNEL_ANSWER updates the registry state and enqueues call.channel.answered', async () => {
      const handler = createChannelHandler({
        db: h.db.kysely,
        registry: h.registry,
        logger: h.logger,
        callSafetyTtlMs: 6 * 60 * 60 * 1000,
        heartbeatTtlMs: 10_000,
      });
      const callUuid = crypto.randomUUID();
      await handler.handleEvent('fs-1', {
        'Event-Name': 'CHANNEL_CREATE',
        'Unique-ID': callUuid,
        'Call-Direction': 'inbound',
      });

      await handler.handleEvent('fs-1', { 'Event-Name': 'CHANNEL_ANSWER', 'Unique-ID': callUuid });

      expect(await h.registry.getCall(callUuid)).toMatchObject({ state: 'answered' });
      const outboxRow = await h.db.kysely
        .selectFrom('outbox')
        .selectAll()
        .where('type', '=', 'call.channel.answered')
        .executeTakeFirst();
      expect(outboxRow).toBeDefined();
    });

    it('CHANNEL_BRIDGE updates the registry with bridgedTo and enqueues call.channel.bridged', async () => {
      const handler = createChannelHandler({
        db: h.db.kysely,
        registry: h.registry,
        logger: h.logger,
        callSafetyTtlMs: 6 * 60 * 60 * 1000,
        heartbeatTtlMs: 10_000,
      });
      const callUuid = crypto.randomUUID();
      await handler.handleEvent('fs-1', { 'Event-Name': 'CHANNEL_CREATE', 'Unique-ID': callUuid });

      await handler.handleEvent('fs-1', {
        'Event-Name': 'CHANNEL_BRIDGE',
        'Unique-ID': callUuid,
        'Other-Leg-Unique-ID': 'other-leg-uuid',
      });

      expect(await h.registry.getCall(callUuid)).toMatchObject({ bridgedTo: 'other-leg-uuid' });
      const outboxRow = await h.db.kysely
        .selectFrom('outbox')
        .selectAll()
        .where('type', '=', 'call.channel.bridged')
        .executeTakeFirst();
      expect(parsePayload(outboxRow?.payload)).toMatchObject({
        callUuid,
        bridgedTo: 'other-leg-uuid',
      });
    });

    it('CHANNEL_HOLD updates the registry state and enqueues call.channel.held', async () => {
      const handler = createChannelHandler({
        db: h.db.kysely,
        registry: h.registry,
        logger: h.logger,
        callSafetyTtlMs: 6 * 60 * 60 * 1000,
        heartbeatTtlMs: 10_000,
      });
      const callUuid = crypto.randomUUID();
      await handler.handleEvent('fs-1', { 'Event-Name': 'CHANNEL_CREATE', 'Unique-ID': callUuid });

      await handler.handleEvent('fs-1', { 'Event-Name': 'CHANNEL_HOLD', 'Unique-ID': callUuid });

      expect(await h.registry.getCall(callUuid)).toMatchObject({ state: 'held' });
      const outboxRow = await h.db.kysely
        .selectFrom('outbox')
        .selectAll()
        .where('type', '=', 'call.channel.held')
        .executeTakeFirst();
      expect(outboxRow).toBeDefined();
    });

    it('CHANNEL_HANGUP_COMPLETE removes the registry entry and enqueues call.channel.hungup with the hangup cause', async () => {
      const handler = createChannelHandler({
        db: h.db.kysely,
        registry: h.registry,
        logger: h.logger,
        callSafetyTtlMs: 6 * 60 * 60 * 1000,
        heartbeatTtlMs: 10_000,
      });
      const callUuid = crypto.randomUUID();
      await handler.handleEvent('fs-1', { 'Event-Name': 'CHANNEL_CREATE', 'Unique-ID': callUuid });

      await handler.handleEvent('fs-1', {
        'Event-Name': 'CHANNEL_HANGUP_COMPLETE',
        'Unique-ID': callUuid,
        'Hangup-Cause': 'NORMAL_CLEARING',
      });

      expect(await h.registry.getCall(callUuid)).toBeUndefined();
      const outboxRow = await h.db.kysely
        .selectFrom('outbox')
        .selectAll()
        .where('type', '=', 'call.channel.hungup')
        .executeTakeFirst();
      expect(parsePayload(outboxRow?.payload)).toMatchObject({
        callUuid,
        nodeId: 'fs-1',
        hangupCause: 'NORMAL_CLEARING',
      });
    });

    it('HEARTBEAT refreshes the node key without touching the outbox', async () => {
      const handler = createChannelHandler({
        db: h.db.kysely,
        registry: h.registry,
        logger: h.logger,
        callSafetyTtlMs: 6 * 60 * 60 * 1000,
        heartbeatTtlMs: 10_000,
      });

      await handler.handleEvent('fs-1', { 'Event-Name': 'HEARTBEAT', 'Core-UUID': 'x' });

      const ttl = await h.redis.pttl(`${h.keyPrefix}fsnode:fs-1`);
      expect(ttl).toBeGreaterThan(0);
      const outboxCount = await h.db.kysely
        .selectFrom('outbox')
        .select(h.db.kysely.fn.countAll().as('n'))
        .executeTakeFirst();
      expect(Number(outboxCount?.n)).toBe(0);
    });

    it('an event with no Unique-ID is ignored', async () => {
      const handler = createChannelHandler({
        db: h.db.kysely,
        registry: h.registry,
        logger: h.logger,
        callSafetyTtlMs: 6 * 60 * 60 * 1000,
        heartbeatTtlMs: 10_000,
      });

      await handler.handleEvent('fs-1', { 'Event-Name': 'CHANNEL_CREATE' });

      const outboxCount = await h.db.kysely
        .selectFrom('outbox')
        .select(h.db.kysely.fn.countAll().as('n'))
        .executeTakeFirst();
      expect(Number(outboxCount?.n)).toBe(0);
    });

    it('a callcenter agent-state-change enqueues call.queue.agent_status_changed (S2-13)', async () => {
      const handler = createChannelHandler({
        db: h.db.kysely,
        registry: h.registry,
        logger: h.logger,
        callSafetyTtlMs: 6 * 60 * 60 * 1000,
        heartbeatTtlMs: 10_000,
      });

      await handler.handleEvent('fs-1', {
        'Event-Name': 'CUSTOM',
        'Event-Subclass': 'callcenter::info',
        'CC-Action': 'agent-state-change',
        'CC-Agent': '101@acme.platform.test',
        'CC-Agent-Status': 'Available',
      });

      const outboxRow = await h.db.kysely
        .selectFrom('outbox')
        .selectAll()
        .where('type', '=', 'call.queue.agent_status_changed')
        .executeTakeFirst();
      expect(outboxRow).toBeDefined();
      expect(parsePayload(outboxRow?.payload)).toMatchObject({
        nodeId: 'fs-1',
        agentName: '101@acme.platform.test',
        status: 'Available',
      });
    });

    it('a call from a trunk (no tenant at CHANNEL_CREATE) joins its tenant live calls when a later event names it (S5-08)', async () => {
      const handler = createChannelHandler({
        db: h.db.kysely,
        registry: h.registry,
        logger: h.logger,
        callSafetyTtlMs: 6 * 60 * 60 * 1000,
        heartbeatTtlMs: 10_000,
      });
      const callUuid = crypto.randomUUID();
      const tenantId = crypto.randomUUID();
      await handler.handleEvent('fs-1', {
        'Event-Name': 'CHANNEL_CREATE',
        'Unique-ID': callUuid,
        'Caller-Caller-ID-Number': '+15550001111',
        'Caller-Destination-Number': '+15551234567',
      });
      expect(await h.registry.callsForTenant(tenantId)).toEqual([]);

      await handler.handleEvent('fs-1', {
        'Event-Name': 'CHANNEL_ANSWER',
        'Unique-ID': callUuid,
        variable_cuc_tenant_id: tenantId,
      });

      expect(await h.registry.callsForTenant(tenantId)).toMatchObject([
        { callUuid, state: 'answered', from: '+15550001111' },
      ]);
      const answered = await h.db.kysely
        .selectFrom('outbox')
        .selectAll()
        .where('type', '=', 'call.channel.answered')
        .executeTakeFirst();
      expect(answered?.tenant_id).toBe(tenantId);

      // The call is announced once, as it stood, before the event that named its tenant.
      const rows = await h.db.kysely
        .selectFrom('outbox')
        .select(['type', 'tenant_id', 'payload'])
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      expect(rows.map((r) => r.type)).toEqual([
        'call.channel.created',
        'call.channel.identified',
        'call.channel.answered',
      ]);
      expect(rows[1]?.tenant_id).toBe(tenantId);
      expect(parsePayload(rows[1]?.payload)).toMatchObject({
        callUuid,
        nodeId: 'fs-1',
        tenantId,
        direction: 'inbound',
        from: '+15550001111',
        to: '+15551234567',
        state: 'ringing',
        answeredAt: null,
        bridgedTo: null,
        recording: 'off',
      });

      // A later event naming the same tenant announces nothing new.
      await handler.handleEvent('fs-1', {
        'Event-Name': 'CHANNEL_HOLD',
        'Unique-ID': callUuid,
        variable_cuc_tenant_id: tenantId,
      });
      const identified = await h.db.kysely
        .selectFrom('outbox')
        .select('id')
        .where('type', '=', 'call.channel.identified')
        .execute();
      expect(identified).toHaveLength(1);
    });

    it('a leg created with no tenant of its own takes the tenant of the leg bridged to it, through to its hangup (S5-08)', async () => {
      const handler = createChannelHandler({
        db: h.db.kysely,
        registry: h.registry,
        logger: h.logger,
        callSafetyTtlMs: 6 * 60 * 60 * 1000,
        heartbeatTtlMs: 10_000,
      });
      const aLeg = crypto.randomUUID();
      const bLeg = crypto.randomUUID();
      const tenantId = crypto.randomUUID();
      await handler.handleEvent('fs-1', {
        'Event-Name': 'CHANNEL_CREATE',
        'Unique-ID': aLeg,
        'Call-Direction': 'inbound',
        'Caller-Caller-ID-Number': '+15550001111',
        'Caller-Destination-Number': '+15551234567',
        variable_cuc_tenant_id: tenantId,
      });
      // FreeSWITCH's leg to the agent's phone: nothing on it names the tenant.
      await handler.handleEvent('fs-1', {
        'Event-Name': 'CHANNEL_CREATE',
        'Unique-ID': bLeg,
        'Call-Direction': 'outbound',
        'Caller-Caller-ID-Number': '+15550001111',
        'Caller-Destination-Number': '401',
      });
      await handler.handleEvent('fs-1', { 'Event-Name': 'CHANNEL_ANSWER', 'Unique-ID': bLeg });
      expect(await h.registry.callsForTenant(tenantId)).toHaveLength(1);

      await handler.handleEvent('fs-1', {
        'Event-Name': 'CHANNEL_BRIDGE',
        'Unique-ID': aLeg,
        'Other-Leg-Unique-ID': bLeg,
        variable_cuc_tenant_id: tenantId,
      });
      expect((await h.registry.callsForTenant(tenantId)).map((c) => c.callUuid).sort()).toEqual(
        [aLeg, bLeg].sort(),
      );

      await handler.handleEvent('fs-1', {
        'Event-Name': 'CHANNEL_HANGUP_COMPLETE',
        'Unique-ID': bLeg,
        'Hangup-Cause': 'NORMAL_CLEARING',
      });
      expect((await h.registry.callsForTenant(tenantId)).map((c) => c.callUuid)).toEqual([aLeg]);

      const rows = await h.db.kysely
        .selectFrom('outbox')
        .select(['type', 'tenant_id', 'payload'])
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      const forB = rows.filter((r) => parsePayload(r.payload)['callUuid'] === bLeg);
      expect(forB.map((r) => [r.type, r.tenant_id])).toEqual([
        ['call.channel.created', null],
        ['call.channel.answered', null],
        ['call.channel.identified', tenantId],
        ['call.channel.hungup', tenantId],
      ]);
      expect(parsePayload(forB[2]?.payload)).toMatchObject({ state: 'answered', to: '401' });
      // The leg is announced before the bridge that names it.
      const types = rows.map((r) => r.type);
      expect(types.indexOf('call.channel.identified')).toBeLessThan(
        types.indexOf('call.channel.bridged'),
      );
    });

    it('CHANNEL_UNHOLD, RECORD_START and RECORD_STOP update the registry and enqueue their events with the tenant (S5-08)', async () => {
      const handler = createChannelHandler({
        db: h.db.kysely,
        registry: h.registry,
        logger: h.logger,
        callSafetyTtlMs: 6 * 60 * 60 * 1000,
        heartbeatTtlMs: 10_000,
      });
      const callUuid = crypto.randomUUID();
      const tenantId = crypto.randomUUID();
      const event = (name: string) => ({
        'Event-Name': name,
        'Unique-ID': callUuid,
        'variable_sip_h_X-Tenant-Id': tenantId,
      });
      await handler.handleEvent('fs-1', event('CHANNEL_CREATE'));
      await handler.handleEvent('fs-1', event('CHANNEL_HOLD'));
      await handler.handleEvent('fs-1', event('CHANNEL_UNHOLD'));
      expect(await h.registry.getCall(callUuid)).toMatchObject({ state: 'answered' });

      await handler.handleEvent('fs-1', event('RECORD_START'));
      expect(await h.registry.getCall(callUuid)).toMatchObject({ recording: 'on' });
      await handler.handleEvent('fs-1', event('RECORD_STOP'));
      expect(await h.registry.getCall(callUuid)).toMatchObject({ recording: 'off' });

      const rows = await h.db.kysely
        .selectFrom('outbox')
        .select(['type', 'tenant_id', 'payload'])
        .where('type', 'in', [
          'call.channel.held',
          'call.channel.unheld',
          'call.channel.recording_started',
          'call.channel.recording_stopped',
        ])
        .execute();
      expect(rows.map((r) => r.type).sort()).toEqual([
        'call.channel.held',
        'call.channel.recording_started',
        'call.channel.recording_stopped',
        'call.channel.unheld',
      ]);
      for (const row of rows) {
        expect(row.tenant_id).toBe(tenantId);
        expect(parsePayload(row.payload)).toEqual({ callUuid, nodeId: 'fs-1' });
      }
    });
  },
);
