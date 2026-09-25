import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { natsOrSkipReason, silentLogger, startTestNats, type TestNatsHandle } from '@cuc/testing';

import { connectBus, DEFAULT_STREAM_MAX_AGE_DAYS, type Bus } from '../src/bus.js';

const skipReason = await natsOrSkipReason();

const NANOS_PER_DAY = 24 * 60 * 60 * 1_000_000_000;

describe.skipIf(skipReason !== undefined)('stream age limit (G-55)', () => {
  let nats: TestNatsHandle;
  const buses: Bus[] = [];

  beforeAll(async () => {
    nats = await startTestNats();
  });

  afterAll(async () => {
    for (const bus of buses) await bus.close();
    await nats?.stop();
  });

  async function bus(streamMaxAgeDays?: number): Promise<Bus> {
    const opened = await connectBus({
      servers: [nats.server],
      logger: silentLogger(),
      name: 'bus-test',
      ...(streamMaxAgeDays === undefined ? {} : { streamMaxAgeDays }),
    });
    buses.push(opened);
    return opened;
  }

  async function maxAgeOf(stream: string, through: Bus): Promise<number> {
    return (await through.jsm.streams.info(stream)).config.max_age;
  }

  it('gives an existing stream with no age limit the default one, keeping its messages', async () => {
    // A deployment from before G-55: the streams exist, with no age limit.
    const before = await bus(0);
    await before.ensureStreams();
    expect(await maxAgeOf('PBX', before)).toBe(0);
    await before.publish({
      id: randomUUID(),
      type: 'pbx.extension.created',
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      orgContext: {},
      data: {},
    });
    const messages = (await before.jsm.streams.info('PBX')).state.messages;
    expect(messages).toBe(1);

    const after = await bus();
    await after.ensureStreams();

    expect(DEFAULT_STREAM_MAX_AGE_DAYS).toBe(7);
    for (const stream of ['PBX', 'IDENTITY', 'ORG']) {
      expect(await maxAgeOf(stream, after)).toBe(7 * NANOS_PER_DAY);
    }
    // Updating the limit did not recreate the stream.
    expect((await after.jsm.streams.info('PBX')).state.messages).toBe(messages);
  });

  it('follows a changed setting, and 0 removes the limit', async () => {
    const two = await bus(2);
    await two.ensureStreams();
    expect(await maxAgeOf('IDENTITY', two)).toBe(2 * NANOS_PER_DAY);

    const none = await bus(0);
    await none.ensureStreams();
    expect(await maxAgeOf('IDENTITY', none)).toBe(0);
  });

  it('refuses a negative or fractional age', async () => {
    await expect(bus(-1)).rejects.toThrow(/whole number of days/);
    await expect(bus(1.5)).rejects.toThrow(/whole number of days/);
  });
});
