import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectBus, type Bus, type EventEnvelope } from '@cuc/events';
import type { PermissionResolver, Server } from '@cuc/http';
import {
  natsOrSkipReason,
  redisOrSkipReason,
  silentLogger,
  startTestNats,
  startTestRedis,
  type TestNatsHandle,
  type TestRedisHandle,
} from '@cuc/testing';
import { Redis } from 'ioredis';
import WebSocket from 'ws';

import { buildApp } from '../src/app.js';
import type { RealtimeHub } from '../src/realtime/hub.js';
import { testConfig } from './config.js';
import {
  baseServerOptions,
  mintAccessToken,
  startFakeJwks,
  type FakeIdentityKeys,
  type MintTokenFields,
} from './helpers.js';

const skipReason = (await redisOrSkipReason()) ?? (await natsOrSkipReason());

const TOKEN = 'test-internal-service-token';
const CONSOLE_HOST = 'console.brand.test';

// The org tree the fake org-service answers for.
const RESELLER_A = randomUUID();
const RESELLER_B = randomUUID();
const TENANT_A = randomUUID(); // under RESELLER_A
const TENANT_B = randomUUID(); // under RESELLER_B
const TENANT_DOWN = randomUUID(); // call-control fails for this one
const MASTER = randomUUID();

interface Message {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** A WebSocket client that keeps every message, so a test can wait for the one it expects. */
class Client {
  readonly messages: Message[] = [];
  closed: { code: number; reason: string } | undefined;
  private waiters: (() => void)[] = [];

  constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      this.messages.push(JSON.parse((data as Buffer).toString('utf8')) as Message);
      this.wake();
    });
    socket.on('close', (code, reason) => {
      this.closed = { code, reason: String(reason) };
      this.wake();
    });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  send(message: object): void {
    this.socket.send(JSON.stringify(message));
  }

  /** The first message (from `from` on) matching `match`; fails after `timeoutMs`. */
  async next(match: (m: Message) => boolean, timeoutMs = 5_000, from = 0): Promise<Message> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.slice(from).find(match);
      if (found !== undefined) return found;
      if (this.closed !== undefined) {
        throw new Error(
          `closed (${String(this.closed.code)} ${this.closed.reason}) waiting for a message`,
        );
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out; got ${JSON.stringify(this.messages)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  async closedWith(timeoutMs = 5_000): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + timeoutMs;
    while (this.closed === undefined) {
      if (Date.now() > deadline) throw new Error('not closed in time');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return this.closed;
  }

  /** Subscribes and waits for the answer: `subscribed` or an `error`. */
  async subscribe(topic: string): Promise<Message> {
    const from = this.messages.length;
    this.send({ type: 'subscribe', topic });
    return this.next(
      (m) => (m.type === 'subscribed' || m.type === 'error') && m['topic'] === topic,
      5_000,
      from,
    );
  }

  close(): void {
    this.socket.close();
  }
}

describe.skipIf(skipReason !== undefined)('api-gateway: realtime hub (S5-08)', () => {
  let redisHandle: TestRedisHandle;
  let redis: Redis;
  let natsHandle: TestNatsHandle;
  let bus: Bus;
  let jwks: FakeIdentityKeys;
  let fakeServices: HttpServer;
  let fakeUrl: string;
  let app: Server;
  let hub: RealtimeHub;
  let wsUrl: string;
  let host: string;
  const opened: Client[] = [];
  const auditRecords: unknown[] = [];

  /** What each person holds, by `${orgId}:${userId}`. A test changes it to revoke. */
  const held = new Map<string, Set<string>>();
  /** A person whose permission lookups wait on a gate, by `${orgId}:${userId}`; a test holds it open. */
  const gates = new Map<string, Promise<void>>();
  const permissions: PermissionResolver = async (actor, permission) => {
    const key = `${actor.orgId}:${actor.id}`;
    await gates.get(key);
    return held.get(key)?.has(permission) ?? false;
  };

  /** The live calls the fake call-control answers with, by tenant. */
  const liveCalls = new Map<string, object[]>();

  beforeAll(async () => {
    redisHandle = await startTestRedis();
    redis = new Redis(redisHandle.url);
    natsHandle = await startTestNats();
    bus = await connectBus({
      servers: [natsHandle.server],
      logger: silentLogger(),
      name: 'realtime-test',
    });
    // call-control creates the streams in production; here the test does.
    await bus.ensureStreams();
    bus.connection.subscribe('audit.>', {
      callback: (_error, message) => {
        auditRecords.push(message.json());
      },
    });
    jwks = await startFakeJwks();

    // One fake for org-service's lineage and call-control's live calls.
    fakeServices = createHttpServer((request, response) => {
      const reply = (status: number, body?: object) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(body === undefined ? undefined : JSON.stringify(body));
      };
      if (request.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, {});
      const url = request.url ?? '';
      const lineage = /^\/internal\/v1\/orgs\/([^/]+)\/lineage$/.exec(url);
      if (lineage !== null) {
        const id = lineage[1];
        if (id === TENANT_A)
          return reply(200, { orgId: id, type: 'tenant', resellerId: RESELLER_A });
        if (id === TENANT_B)
          return reply(200, { orgId: id, type: 'tenant', resellerId: RESELLER_B });
        return reply(404, {});
      }
      const calls = /^\/internal\/v1\/tenants\/([^/]+)\/calls$/.exec(url);
      if (calls !== null) {
        if (calls[1] === TENANT_DOWN) return reply(500, {});
        return reply(200, { calls: liveCalls.get(calls[1] ?? '') ?? [] });
      }
      return reply(404, {});
    });
    await new Promise<void>((resolve) => fakeServices.listen(0, '127.0.0.1', resolve));
    fakeUrl = `http://127.0.0.1:${String((fakeServices.address() as AddressInfo).port)}`;

    app = await buildApp({
      config: testConfig({
        REDIS_URL: redisHandle.url,
        REALTIME_ENABLED: 'true',
        INTERNAL_SERVICE_TOKEN: TOKEN,
        ORG_SERVICE_URL: fakeUrl,
        CALL_CONTROL_URL: fakeUrl,
        CONSOLE_HOSTNAMES: CONSOLE_HOST,
        REALTIME_AUTH_TIMEOUT_MS: '1000',
        REALTIME_PERMISSION_RECHECK_MS: '1000',
        REALTIME_MAX_SUBSCRIPTIONS: '3',
        REALTIME_MAX_MESSAGES_PER_MINUTE: '40',
        REALTIME_MAX_MESSAGE_BYTES: '2048',
        REALTIME_MAX_CONNECTIONS_PER_USER: '3',
        REALTIME_MAX_CONNECTIONS_PER_IP: '12',
      }),
      redis,
      jwksUrl: jwks.jwksUrl,
      rateLimitKeyPrefix: `${redisHandle.keyPrefix}rt:`,
      realtime: {
        permissions,
        onHub: (created) => {
          hub = created;
        },
      },
      ...baseServerOptions(),
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    host = `127.0.0.1:${String(port)}`;
    wsUrl = `ws://${host}/v1/ws`;

    hub.attachBus(bus);
    const deadline = Date.now() + 15_000;
    while (!hub.feedLive) {
      if (Date.now() > deadline) throw new Error('the realtime feed never started reading');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });

  afterAll(async () => {
    for (const client of opened) client.socket.terminate();
    await app?.close();
    await bus?.close();
    await natsHandle?.stop();
    await jwks?.stop();
    await new Promise((resolve) => fakeServices?.close(resolve));
    redis?.disconnect();
    await redisHandle?.stop();
  });

  /** Opens a socket; resolves once open, or rejects with the HTTP status the upgrade got. */
  async function open(origin: string | undefined = `http://${host}`): Promise<Client> {
    const socket = new WebSocket(wsUrl, origin === undefined ? {} : { headers: { origin } });
    const client = new Client(socket);
    opened.push(client);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('unexpected-response', (_request, response) =>
        reject(new Error(`HTTP ${String(response.statusCode)}`)),
      );
      socket.once('error', reject);
    });
    return client;
  }

  interface Person extends MintTokenFields {
    readonly sub: string;
  }

  function person(org: string, ot: Person['ot'], perms: string[]): Person {
    const sub = randomUUID();
    held.set(`${org}:${sub}`, new Set(perms));
    return { sub, org, ot };
  }

  async function connectAs(who: Person, expiresInSeconds = 600): Promise<Client> {
    const client = await open();
    client.send({
      type: 'auth',
      token: await mintAccessToken(jwks.privateKey, { ...who, expiresInSeconds }),
    });
    await client.next((m) => m.type === 'authenticated');
    return client;
  }

  async function publish(type: string, tenantId: string | undefined, data: object): Promise<void> {
    const envelope: EventEnvelope = {
      id: randomUUID(),
      type,
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      orgContext: tenantId === undefined ? {} : { tenantId },
      data,
    };
    await bus.publish(envelope);
  }

  const topic = (tenantId: string, kind: string) => `tenant:${tenantId}:${kind}`;

  describe('handshake', () => {
    it('answers a plain GET with 426', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/ws' });
      expect(response.statusCode).toBe(426);
      expect(response.json()).toMatchObject({ code: 'upgrade_required' });
    });

    it('authenticates with the first message and says when the token expires', async () => {
      const admin = person(TENANT_A, 'tenant', ['monitor.presence']);
      const client = await open();
      const token = await mintAccessToken(jwks.privateKey, admin);
      client.send({ type: 'auth', token });
      const authenticated = await client.next((m) => m.type === 'authenticated');
      expect(authenticated).toMatchObject({ v: 1 });
      expect(Date.parse(String(authenticated['expiresAt']))).toBeGreaterThan(Date.now());
      client.close();
    });

    it('closes a connection that does not authenticate in time', async () => {
      const client = await open();
      expect(await client.closedWith()).toEqual({ code: 4401, reason: 'Authentication required' });
    });

    it('closes a connection that asks for anything before authenticating', async () => {
      const client = await open();
      client.send({ type: 'subscribe', topic: topic(TENANT_A, 'presence') });
      expect(await client.closedWith()).toEqual({ code: 4401, reason: 'Authentication required' });
    });

    it('closes on an invalid, forged or expired token', async () => {
      const other = await startFakeJwks();
      try {
        for (const token of [
          'not-a-token',
          await mintAccessToken(other.privateKey, { org: TENANT_A, ot: 'tenant' }),
          await mintAccessToken(jwks.privateKey, {
            org: TENANT_A,
            ot: 'tenant',
            expiresInSeconds: -5,
          }),
        ]) {
          const client = await open();
          client.send({ type: 'auth', token });
          expect(await client.closedWith()).toEqual({ code: 4401, reason: 'Invalid token' });
        }
      } finally {
        await other.stop();
      }
    });

    it('closes the connection when the token expires without being replaced', async () => {
      const user = person(TENANT_A, 'tenant', ['monitor.presence']);
      const client = await connectAs(user, 2);
      expect(await client.closedWith(6_000)).toEqual({ code: 4401, reason: 'Session expired' });
    });

    it('keeps the connection open when a fresh token arrives before expiry', async () => {
      const user = person(TENANT_A, 'tenant', ['monitor.presence']);
      const client = await connectAs(user, 2);
      const from = client.messages.length;
      client.send({
        type: 'auth',
        token: await mintAccessToken(jwks.privateKey, { ...user, expiresInSeconds: 600 }),
      });
      await client.next((m) => m.type === 'authenticated', 5_000, from);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(client.closed).toBeUndefined();
      client.close();
    });

    it('closes when a later token names someone else', async () => {
      const user = person(TENANT_A, 'tenant', ['monitor.presence']);
      const client = await connectAs(user);
      client.send({
        type: 'auth',
        token: await mintAccessToken(jwks.privateKey, { org: TENANT_A, ot: 'tenant' }),
      });
      expect(await client.closedWith()).toEqual({ code: 4403, reason: 'Identity changed' });
    });
  });

  describe('origin', () => {
    it('allows the gateway own origin, a console hostname, and a client that sends none', async () => {
      for (const origin of [`http://${host}`, `https://${CONSOLE_HOST}`, undefined]) {
        const client = await open(origin);
        client.close();
      }
    });

    it('refuses any other origin before upgrading', async () => {
      await expect(open('https://elsewhere.test')).rejects.toThrow('HTTP 403');
    });
  });

  describe('subscriptions', () => {
    it('refuses an unknown topic', async () => {
      const client = await connectAs(person(TENANT_A, 'tenant', ['monitor.calls']));
      expect(await client.subscribe(`tenant:${TENANT_A}:recordings`)).toMatchObject({
        type: 'error',
        code: 'unknown_topic',
      });
      client.close();
    });

    it('keeps a tenant person inside their own tenant (H2)', async () => {
      const client = await connectAs(
        person(TENANT_A, 'tenant', ['monitor.presence', 'monitor.calls']),
      );
      expect(await client.subscribe(topic(TENANT_B, 'presence'))).toMatchObject({
        type: 'error',
        code: 'forbidden',
      });
      expect(await client.subscribe(topic(TENANT_B, 'calls'))).toMatchObject({
        type: 'error',
        code: 'forbidden',
      });
      client.close();
    });

    it('refuses a topic whose permission the person does not hold', async () => {
      const client = await connectAs(person(TENANT_A, 'tenant', ['monitor.presence']));
      expect(await client.subscribe(topic(TENANT_A, 'calls'))).toMatchObject({
        type: 'error',
        code: 'permission_denied',
      });
      expect(await client.subscribe(topic(TENANT_A, 'queues'))).toMatchObject({
        type: 'error',
        code: 'permission_denied',
      });
      expect(await client.subscribe(topic(TENANT_A, 'presence'))).toMatchObject({
        type: 'subscribed',
      });
      client.close();
    });

    it('never gives a reseller live calls, whatever it holds (H1), but gives its own tenants presence', async () => {
      const client = await connectAs(
        person(RESELLER_A, 'reseller', ['monitor.calls', 'monitor.presence', 'queue.read']),
      );
      expect(await client.subscribe(topic(TENANT_A, 'calls'))).toMatchObject({
        type: 'error',
        code: 'reseller_private_data_denied',
      });
      expect(await client.subscribe(topic(TENANT_A, 'presence'))).toMatchObject({
        type: 'subscribed',
      });
      expect(await client.subscribe(topic(TENANT_A, 'queues'))).toMatchObject({
        type: 'subscribed',
      });
      // Another reseller's tenant, and an org that does not exist.
      expect(await client.subscribe(topic(TENANT_B, 'presence'))).toMatchObject({
        type: 'error',
        code: 'forbidden',
      });
      expect(await client.subscribe(topic(randomUUID(), 'presence'))).toMatchObject({
        type: 'error',
        code: 'forbidden',
      });
      client.close();
    });

    it('lets the master watch any tenant live calls, and audits it', async () => {
      const master = person(MASTER, 'master', ['monitor.calls']);
      const client = await connectAs(master);
      expect(await client.subscribe(topic(TENANT_B, 'calls'))).toMatchObject({
        type: 'subscribed',
      });
      await expect
        .poll(() =>
          auditRecords.find(
            (r) => (r as { data?: { actorId?: string } }).data?.actorId === master.sub,
          ),
        )
        .toMatchObject({
          type: 'audit.event.recorded',
          data: {
            actorId: master.sub,
            actorOrgId: MASTER,
            targetOrgId: TENANT_B,
            action: 'realtime.calls.subscribed',
            resource: topic(TENANT_B, 'calls'),
            dataClass: 'private',
          },
        });
      client.close();
    });

    it('limits the subscriptions on one connection', async () => {
      const client = await connectAs(
        person(TENANT_A, 'tenant', ['monitor.presence', 'queue.read', 'monitor.calls']),
      );
      for (const kind of ['presence', 'queues', 'calls']) {
        expect(await client.subscribe(topic(TENANT_A, kind))).toMatchObject({ type: 'subscribed' });
      }
      // A fourth is one past the limit of three here ...
      expect(await client.subscribe(topic(TENANT_B, 'presence'))).toMatchObject({
        type: 'error',
        code: 'too_many_subscriptions',
      });
      // ... but subscribing again to one already held replaces it, and room freed is usable.
      expect(await client.subscribe(topic(TENANT_A, 'presence'))).toMatchObject({
        type: 'subscribed',
      });
      client.send({ type: 'unsubscribe', topic: topic(TENANT_A, 'queues'), id: 'u1' });
      expect(await client.next((m) => m.type === 'unsubscribed' && m['id'] === 'u1')).toEqual({
        type: 'unsubscribed',
        topic: topic(TENANT_A, 'queues'),
        id: 'u1',
      });
      expect(await client.subscribe(topic(TENANT_A, 'queues'))).toMatchObject({
        type: 'subscribed',
      });
      client.close();
    });

    it('cancels a subscribe still being authorized when the client unsubscribes', async () => {
      const who = person(TENANT_A, 'tenant', ['monitor.presence', 'queue.read']);
      const client = await connectAs(who);
      let release = () => {};
      gates.set(
        `${who.org}:${who.sub}`,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      const presence = topic(TENANT_A, 'presence');
      client.send({ type: 'subscribe', topic: presence, id: 's1' });
      client.send({ type: 'unsubscribe', topic: presence, id: 'u1' });
      expect(await client.next((m) => m['id'] === 'u1')).toEqual({
        type: 'unsubscribed',
        topic: presence,
        id: 'u1',
      });
      release();
      gates.delete(`${who.org}:${who.sub}`);
      // A later subscribe is answered, and the cancelled one never was.
      expect(await client.subscribe(topic(TENANT_A, 'queues'))).toMatchObject({
        type: 'subscribed',
      });
      expect(client.messages.filter((m) => m['topic'] === presence)).toEqual([
        { type: 'unsubscribed', topic: presence, id: 'u1' },
      ]);
      client.close();
    });

    it('counts subscribes still being authorized against the limit', async () => {
      const who = person(TENANT_A, 'tenant', ['monitor.presence', 'queue.read', 'monitor.calls']);
      const client = await connectAs(who);
      let release = () => {};
      gates.set(
        `${who.org}:${who.sub}`,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      for (const kind of ['presence', 'queues', 'calls']) {
        client.send({ type: 'subscribe', topic: topic(TENANT_A, kind) });
      }
      client.send({ type: 'subscribe', topic: topic(TENANT_B, 'presence'), id: 'fourth' });
      expect(await client.next((m) => m['id'] === 'fourth')).toMatchObject({
        type: 'error',
        code: 'too_many_subscriptions',
      });
      release();
      gates.delete(`${who.org}:${who.sub}`);
      for (const kind of ['presence', 'queues', 'calls']) {
        expect(
          await client.next((m) => m.type === 'subscribed' && m['topic'] === topic(TENANT_A, kind)),
        ).toBeDefined();
      }
      client.close();
    });

    it('answers unsubscribing from a topic it does not hold', async () => {
      const client = await connectAs(person(TENANT_A, 'tenant', []));
      client.send({ type: 'unsubscribe', topic: topic(TENANT_A, 'calls'), id: 'x' });
      expect(await client.next((m) => m.type === 'error')).toMatchObject({
        code: 'not_subscribed',
        id: 'x',
      });
      client.close();
    });
  });

  describe('live calls', () => {
    it('sends a snapshot on subscribe, then the changes, and only to subscribers of that tenant', async () => {
      const tenantId = TENANT_A;
      const existing = randomUUID();
      liveCalls.set(tenantId, [
        {
          callUuid: existing,
          nodeId: 'fs-1',
          tenantId,
          direction: 'inbound',
          state: 'answered',
          startedAt: Date.parse('2026-09-25T10:00:00.000Z'),
          answeredAt: Date.parse('2026-09-25T10:00:03.000Z'),
          from: '101',
          to: '+15551234567',
          bridgedTo: null,
          recording: 'on',
        },
      ]);
      const watcherA = await connectAs(person(TENANT_A, 'tenant', ['monitor.calls']));
      const watcherB = await connectAs(person(TENANT_B, 'tenant', ['monitor.calls']));
      const presenceOnly = await connectAs(person(TENANT_A, 'tenant', ['monitor.presence']));

      expect(await watcherA.subscribe(topic(TENANT_A, 'calls'))).toMatchObject({
        type: 'subscribed',
      });
      const snapshot = await watcherA.next((m) => m.type === 'snapshot');
      expect(snapshot).toEqual({
        type: 'snapshot',
        topic: topic(TENANT_A, 'calls'),
        data: {
          calls: [
            {
              callUuid: existing,
              direction: 'inbound',
              state: 'answered',
              from: '101',
              to: '+15551234567',
              startedAt: '2026-09-25T10:00:00.000Z',
              answeredAt: '2026-09-25T10:00:03.000Z',
              bridgedTo: null,
              recording: 'on',
            },
          ],
        },
      });
      expect(await watcherB.subscribe(topic(TENANT_B, 'calls'))).toMatchObject({
        type: 'subscribed',
      });
      expect(await presenceOnly.subscribe(topic(TENANT_A, 'presence'))).toMatchObject({
        type: 'subscribed',
      });
      const presenceSnapshot = await presenceOnly.next((m) => m.type === 'snapshot');
      expect(presenceSnapshot['data']).toEqual({
        extensions: [{ extension: '101', state: 'on_call' }],
      });

      const callUuid = randomUUID();
      await publish('call.channel.created', TENANT_A, {
        callUuid,
        nodeId: 'fs-2',
        tenantId: TENANT_A,
        direction: 'outbound',
        from: '101',
        to: '102',
      });
      const started = await watcherA.next((m) => m.type === 'event');
      expect(started).toMatchObject({
        topic: topic(TENANT_A, 'calls'),
        event: {
          type: 'call.started',
          call: { callUuid, direction: 'outbound', from: '101', to: '102', state: 'ringing' },
        },
      });
      expect(JSON.stringify(started)).not.toContain('fs-2');

      // Presence subscribers learn 102 is ringing, without the call or its parties.
      const ringing = await presenceOnly.next((m) => m.type === 'event');
      expect(ringing).toEqual({
        type: 'event',
        topic: topic(TENANT_A, 'presence'),
        event: { type: 'presence.changed', extension: '102', state: 'ringing' },
      });

      await publish('call.channel.recording_started', TENANT_A, { callUuid, nodeId: 'fs-2' });
      await publish('call.channel.hungup', TENANT_A, {
        callUuid,
        nodeId: 'fs-2',
        hangupCause: 'NORMAL_CLEARING',
      });
      await watcherA.next(
        (m) => m.type === 'event' && (m['event'] as { type: string }).type === 'call.ended',
      );
      const events = watcherA.messages
        .filter((m) => m.type === 'event')
        .map((m) => m['event'] as { type: string; changes?: object });
      expect(events.map((e) => e.type)).toEqual(['call.started', 'call.updated', 'call.ended']);
      expect(events[1]?.changes).toEqual({ recording: 'on' });
      await presenceOnly.next(
        (m) => m.type === 'event' && (m['event'] as { state: string }).state === 'idle',
      );

      // Nothing reached the other tenant, and an event with no tenant reaches nobody.
      await publish('call.channel.held', undefined, { callUuid, nodeId: 'fs-2' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(watcherB.messages.filter((m) => m.type === 'event')).toEqual([]);
      expect(presenceOnly.messages.some((m) => JSON.stringify(m).includes(callUuid))).toBe(false);

      for (const client of [watcherA, watcherB, presenceOnly]) client.close();
    });

    it('refuses the subscription when call-control cannot answer', async () => {
      const client = await connectAs(
        person(TENANT_DOWN, 'tenant', ['monitor.calls', 'monitor.presence']),
      );
      expect(await client.subscribe(topic(TENANT_DOWN, 'calls'))).toMatchObject({
        type: 'error',
        code: 'unavailable',
      });
      expect(await client.subscribe(topic(TENANT_DOWN, 'presence'))).toMatchObject({
        type: 'error',
        code: 'unavailable',
      });
      client.close();
    });

    it('ends the stream when the permission is taken away', async () => {
      const supervisor = person(TENANT_B, 'tenant', ['monitor.calls']);
      const client = await connectAs(supervisor);
      expect(await client.subscribe(topic(TENANT_B, 'calls'))).toMatchObject({
        type: 'subscribed',
      });

      held.set(`${TENANT_B}:${supervisor.sub}`, new Set());
      expect(await client.next((m) => m.type === 'unsubscribed', 5_000)).toEqual({
        type: 'unsubscribed',
        topic: topic(TENANT_B, 'calls'),
        code: 'permission_denied',
      });

      await publish('call.channel.created', TENANT_B, {
        callUuid: randomUUID(),
        nodeId: 'fs-1',
        tenantId: TENANT_B,
        direction: 'inbound',
        from: '201',
        to: '202',
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(client.messages.filter((m) => m.type === 'event')).toEqual([]);
      client.close();
    });
  });

  describe('limits', () => {
    it('closes a connection that sends a frame over the size limit (1009)', async () => {
      const client = await connectAs(person(TENANT_A, 'tenant', []));
      client.send({ type: 'subscribe', topic: 'x'.repeat(4_000) });
      expect((await client.closedWith()).code).toBe(1009);
    });

    it('closes a connection that sends too many messages (1008)', async () => {
      const client = await connectAs(person(TENANT_A, 'tenant', []));
      for (let i = 0; i < 45; i += 1) client.send({ type: 'unsubscribe', topic: 'x' });
      expect(await client.closedWith()).toEqual({ code: 1008, reason: 'Too many messages' });
    });

    it('answers a malformed message with an error, not a close, once authenticated', async () => {
      const client = await connectAs(person(TENANT_A, 'tenant', []));
      client.socket.send('not json');
      expect(await client.next((m) => m.type === 'error')).toMatchObject({ code: 'bad_message' });
      client.send({ type: 'publish', id: 'p' });
      expect(await client.next((m) => m.type === 'error' && m['id'] === 'p')).toMatchObject({
        code: 'unknown_type',
      });
      client.close();
    });

    it('limits one person to a few connections at once', async () => {
      const user = person(TENANT_A, 'tenant', []);
      const first = await Promise.all([connectAs(user), connectAs(user), connectAs(user)]);
      const fourth = await open();
      fourth.send({ type: 'auth', token: await mintAccessToken(jwks.privateKey, user) });
      expect(await fourth.closedWith()).toEqual({ code: 1013, reason: 'Too many connections' });
      for (const client of first) client.close();
    });

    it('limits the connections from one address, refusing the upgrade', async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const held: Client[] = [];
      while (hub.connectionCount < 12) held.push(await open());
      await expect(open()).rejects.toThrow('HTTP 429');
      for (const client of held) client.close();
    });
  });
});
