import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, redisOrSkipReason } from '@cuc/testing';

import { createChannelHandler } from '../src/channel-handler.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await redisOrSkipReason());

/** MariaDB's `json` column type comes back already parsed via mysql2; a string only if some other driver is ever used. */
function parsePayload(payload: unknown): Record<string, unknown> {
  return typeof payload === 'string' ? (JSON.parse(payload) as Record<string, unknown>) : (payload as Record<string, unknown>);
}

describe.skipIf(skipReason !== undefined)('channel handler (ESL event -> outbox + Redis registry)', () => {
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
    expect(parsePayload(outboxRow?.payload)).toMatchObject({ callUuid, bridgedTo: 'other-leg-uuid' });
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
});
