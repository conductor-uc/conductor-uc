import { connect as netConnect } from 'node:net';

import { silentLogger } from '@cuc/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { createEslClient, type EslClient } from '../src/esl/client.js';
import { startFakeEslServer, type FakeEslServer } from './fake-esl-server.js';

const PASSWORD = 'test-esl-password';

describe('createEslClient', () => {
  let server: FakeEslServer | undefined;
  let client: EslClient | undefined;

  afterEach(async () => {
    if (client !== undefined) await client.stop();
    if (server !== undefined) await server.close();
    server = undefined;
    client = undefined;
  });

  it('authenticates, subscribes, and delivers a broadcast event', async () => {
    server = await startFakeEslServer(PASSWORD);
    const events: { nodeId: string; event: Record<string, string> }[] = [];
    const connected: string[] = [];

    client = createEslClient({
      node: { id: 'fs-1', host: '127.0.0.1', port: server.port },
      password: PASSWORD,
      logger: silentLogger(),
      reconnectMinDelayMs: 50,
      reconnectMaxDelayMs: 200,
      onEvent: (nodeId, event) => events.push({ nodeId, event }),
      onConnect: (nodeId) => connected.push(nodeId),
      connect: (port, host) => netConnect(port, host),
    });
    client.start();

    await waitFor(() => connected.includes('fs-1'));

    server.broadcastEvent({ 'Event-Name': 'HEARTBEAT', 'Core-UUID': 'x' });
    await waitFor(() => events.length === 1);

    expect(events[0]).toEqual({
      nodeId: 'fs-1',
      event: { 'Event-Name': 'HEARTBEAT', 'Core-UUID': 'x' },
    });
  });

  it('reconnects with backoff after the connection drops, and resumes delivering events', async () => {
    server = await startFakeEslServer(PASSWORD);
    const connectedTimes: number[] = [];
    const disconnectedTimes: number[] = [];
    const events: unknown[] = [];

    client = createEslClient({
      node: { id: 'fs-1', host: '127.0.0.1', port: server.port },
      password: PASSWORD,
      logger: silentLogger(),
      reconnectMinDelayMs: 30,
      reconnectMaxDelayMs: 100,
      onEvent: (_nodeId, event) => events.push(event),
      onConnect: () => connectedTimes.push(Date.now()),
      onDisconnect: () => disconnectedTimes.push(Date.now()),
      connect: (port, host) => netConnect(port, host),
    });
    client.start();

    await waitFor(() => connectedTimes.length === 1);
    server.dropAllConnections();
    await waitFor(() => disconnectedTimes.length === 1);
    await waitFor(() => connectedTimes.length === 2);

    server.broadcastEvent({ 'Event-Name': 'CHANNEL_CREATE', 'Unique-ID': 'abc' });
    await waitFor(() => events.length === 1);
  });

  it('does not reach onConnect when the password is rejected', async () => {
    server = await startFakeEslServer(PASSWORD);
    server.rejectNextAuth = true;
    let connected = false;

    client = createEslClient({
      node: { id: 'fs-1', host: '127.0.0.1', port: server.port },
      password: 'wrong-password',
      logger: silentLogger(),
      reconnectMinDelayMs: 10_000, // long enough that a retry within the test window would be a bug, not a race
      reconnectMaxDelayMs: 10_000,
      onEvent: () => {},
      onConnect: () => {
        connected = true;
      },
      connect: (port, host) => netConnect(port, host),
    });
    client.start();

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(connected).toBe(false);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
