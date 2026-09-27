import type { Bus } from '@cuc/events';
import { ProblemError, sharedReading, type PermissionResolver, type Server } from '@cuc/http';
import type { Redis } from 'ioredis';

/**
 * The operations console's access check (S4-12, G-124): a master actor holding
 * `platform.observe` (identity-service, through the same resolver as the realtime hub). H3 keeps
 * the permission from anyone outside the master anyway; the org check makes that explicit here.
 */
export async function requireObserver(
  context: {
    readonly actorId?: string;
    readonly actorType?: string;
    readonly orgId?: string;
    readonly orgType?: string;
  },
  permissions: PermissionResolver,
): Promise<void> {
  const { actorId, actorType, orgId, orgType } = context;
  if (orgType !== 'master' || actorId === undefined || orgId === undefined) {
    throw ProblemError.forbidden('Only the master can see the platform.');
  }
  if (
    actorType === 'user' &&
    !(await permissions({ id: actorId, orgId, orgType }, 'platform.observe'))
  ) {
    throw ProblemError.forbidden('You do not have access to the operations console.', {
      code: 'insufficient_permission',
    });
  }
}

/** One service the overview asks for its `/statusz` (S4-12). */
export interface StatusTarget {
  readonly name: string;
  /** Its base URL, or `self` for this gateway (asked in-process). */
  readonly url: string;
}

export interface PlatformOverviewOptions {
  readonly targets: readonly StatusTarget[];
  /** call-control, for the media nodes. */
  readonly callControlUrl: string;
  /** telephony-config, for the SIP edge, the dispatcher and MariaDB; optional like presence. */
  readonly telephonyConfigUrl?: string;
  /** NATS' monitoring endpoint (`-m 8222`), for the server's own figures; optional. */
  readonly natsMonitorUrl?: string;
  readonly internalServiceToken: string;
  readonly redis: Redis;
  /** The gateway's NATS connection, once it has one. */
  readonly bus: () => Bus | undefined;
  /** Whether a person holds `platform.observe` (identity-service). */
  readonly permissions: PermissionResolver;
  /** How long any one source has to answer. */
  readonly timeoutMs: number;
}

type Json = Record<string, unknown>;

interface Fact {
  readonly label: string;
  readonly value: number;
  readonly unit: 'bytes' | 'count' | 'perSecond' | 'seconds' | 'percent';
}

interface DataStore {
  readonly name: string;
  readonly status: 'up' | 'down';
  readonly version: string | null;
  readonly uptimeSeconds: number | null;
  readonly facts: readonly Fact[];
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** A per-second rate between two readings of an ever-growing counter, kept per name. */
function rates(): (name: string, counter: number) => number | null {
  const last = new Map<string, { value: number; at: number }>();
  return (name, counter) => {
    const now = Date.now();
    const previous = last.get(name);
    last.set(name, { value: counter, at: now });
    if (previous === undefined || now <= previous.at || counter < previous.value) return null;
    return Math.round(((counter - previous.value) / ((now - previous.at) / 1000)) * 10) / 10;
  };
}

/**
 * `GET /v1/platform/overview` (S4-12, docs/architecture/11-operations-console.md): the master's
 * operations console, in one answer. Served by the gateway because it asks every part of the
 * platform and no one service owns that. Each source is asked in parallel with its own timeout,
 * and one that does not answer is shown as down or null, never a failed page.
 *
 * `platform.observe` is checked here (identity-service, through the same resolver as the realtime
 * hub), on top of the master-only org check: hard rule H3 reserves it to the master anyway.
 */
export function registerPlatformOverview(app: Server, options: PlatformOverviewOptions): void {
  const { timeoutMs, internalServiceToken } = options;
  const rate = rates();
  const auth = { authorization: `Bearer ${internalServiceToken}` };

  async function getJson(
    url: URL | string,
    withToken: boolean,
  ): Promise<{ ms: number; body: Json }> {
    const started = Date.now();
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      ...(withToken ? { headers: auth } : {}),
    });
    if (!response.ok) throw new Error(`${String(response.status)} from ${String(url)}`);
    return { ms: Date.now() - started, body: (await response.json()) as Json };
  }

  async function service(target: StatusTarget): Promise<Json> {
    const started = Date.now();
    try {
      const { ms, body } =
        target.url === 'self'
          ? await app
              .inject({ method: 'GET', url: '/statusz' })
              .then((response) => ({ ms: Date.now() - started, body: response.json<Json>() }))
          : await getJson(new URL('/statusz', target.url), false);
      const sections = (body['sections'] ?? {}) as Json;
      const outbox = sections['outbox'] as Json | null | undefined;
      const memory = body['memory'] as Json | undefined;
      return {
        name: target.name,
        status: body['ready'] === true ? 'up' : 'degraded',
        latencyMs: ms,
        version: typeof body['version'] === 'string' ? body['version'] : null,
        uptimeSeconds: num(body['uptimeSeconds']),
        checks: Array.isArray(body['checks']) ? body['checks'] : [],
        memory:
          memory === undefined
            ? null
            : { rssBytes: num(memory['rssBytes']), heapUsedBytes: num(memory['heapUsedBytes']) },
        // A section named `facts` (the uploaders' spool) is shown as it is, like a store's.
        facts: Array.isArray(sections['facts']) ? sections['facts'] : [],
        outbox:
          outbox === undefined || outbox === null
            ? null
            : {
                pending: num(outbox['pending']) ?? 0,
                oldestPendingSeconds: num(outbox['oldestPendingSeconds']),
                failed: num(outbox['failed']) ?? 0,
              },
      };
    } catch {
      return {
        name: target.name,
        status: 'down',
        latencyMs: Date.now() - started,
        version: null,
        uptimeSeconds: null,
        checks: [],
        memory: null,
        facts: [],
        outbox: null,
      };
    }
  }

  async function telephonyStatus(): Promise<Json | null> {
    if (options.telephonyConfigUrl === undefined) return null;
    try {
      return (
        await getJson(new URL('/internal/v1/platform/status', options.telephonyConfigUrl), true)
      ).body;
    } catch {
      return null;
    }
  }

  async function nodes(telephonyStatusRead: Promise<Json | null>): Promise<Json[]> {
    let listed: Json[];
    try {
      const { body } = await getJson(new URL('/internal/v1/nodes', options.callControlUrl), true);
      listed = (body['nodes'] as Json[] | undefined) ?? [];
    } catch {
      return [];
    }
    const telephony = await telephonyStatusRead;
    const pool = (telephony?.['dispatcher'] as Json[] | null | undefined) ?? null;
    return listed.map((node) => {
      const destination = pool?.find((entry) => entry['nodeId'] === node['nodeId']);
      return {
        ...node,
        weight: destination === undefined ? null : num(destination['weight']),
        // Unknown when telephony-config did not answer; `absent` when it did and no row names it.
        dispatcher: pool === null ? null : (destination?.['state'] ?? 'absent'),
        uri: destination === undefined ? null : destination['uri'],
      };
    });
  }

  async function events(): Promise<Json | null> {
    const bus = options.bus();
    if (bus === undefined) return null;
    try {
      const streams: Json[] = [];
      const consumers: Json[] = [];
      for await (const stream of bus.jsm.streams.list()) {
        streams.push({
          name: stream.config.name,
          messages: stream.state.messages,
          bytes: stream.state.bytes,
          consumers: stream.state.consumer_count,
        });
        for await (const consumer of bus.jsm.consumers.list(stream.config.name)) {
          // Durable consumers are the services'; ephemeral ones (the realtime feed) come and go.
          if (consumer.config.durable_name === undefined) continue;
          consumers.push({
            stream: stream.config.name,
            name: consumer.config.durable_name,
            pending: consumer.num_pending,
            ackPending: consumer.num_ack_pending,
            redelivered: consumer.num_redelivered,
          });
        }
      }
      return { streams, consumers };
    } catch {
      return null;
    }
  }

  async function redisStore(): Promise<DataStore> {
    try {
      const info = await options.redis.info();
      const field = (name: string): string | undefined =>
        new RegExp(`^${name}:(.*)$`, 'm').exec(info)?.[1]?.trim();
      const count = (name: string): number => Number(field(name) ?? 0);
      const keys = [...info.matchAll(/^db\d+:keys=(\d+)/gm)].reduce(
        (sum, match) => sum + Number(match[1]),
        0,
      );
      return {
        name: 'redis',
        status: 'up',
        version: field('redis_version') ?? null,
        uptimeSeconds: count('uptime_in_seconds'),
        facts: [
          {
            label: 'Operations per second',
            value: count('instantaneous_ops_per_sec'),
            unit: 'perSecond',
          },
          { label: 'Memory used', value: count('used_memory'), unit: 'bytes' },
          { label: 'Clients', value: count('connected_clients'), unit: 'count' },
          { label: 'Keys', value: keys, unit: 'count' },
        ],
      };
    } catch {
      return { name: 'redis', status: 'down', version: null, uptimeSeconds: null, facts: [] };
    }
  }

  async function natsStore(): Promise<DataStore> {
    const bus = options.bus();
    const down: DataStore = {
      name: 'nats',
      status: 'down',
      version: null,
      uptimeSeconds: null,
      facts: [],
    };
    if (bus === undefined) return down;
    const version = bus.connection.info?.version ?? null;
    if (options.natsMonitorUrl === undefined) {
      return { name: 'nats', status: 'up', version, uptimeSeconds: null, facts: [] };
    }
    try {
      const { body } = await getJson(new URL('/varz', options.natsMonitorUrl), false);
      const started = typeof body['start'] === 'string' ? Date.parse(body['start']) : Number.NaN;
      const facts: Fact[] = [];
      const inMsgs = num(body['in_msgs']);
      const perSecond = inMsgs === null ? null : rate('nats.in_msgs', inMsgs);
      if (perSecond !== null) {
        facts.push({ label: 'Messages in per second', value: perSecond, unit: 'perSecond' });
      }
      facts.push({ label: 'Connections', value: num(body['connections']) ?? 0, unit: 'count' });
      facts.push({ label: 'Memory used', value: num(body['mem']) ?? 0, unit: 'bytes' });
      const jetstream = (body['jetstream'] as Json | undefined)?.['stats'] as Json | undefined;
      if (jetstream !== undefined) {
        facts.push({
          label: 'Stream storage',
          value: num(jetstream['storage']) ?? 0,
          unit: 'bytes',
        });
      }
      return {
        name: 'nats',
        status: 'up',
        version: typeof body['version'] === 'string' ? body['version'] : version,
        uptimeSeconds: Number.isNaN(started) ? null : Math.round((Date.now() - started) / 1000),
        facts,
      };
    } catch {
      // The connection works; only its monitoring port did not answer.
      return { name: 'nats', status: 'up', version, uptimeSeconds: null, facts: [] };
    }
  }

  app.get(
    '/v1/platform/overview',
    { config: { permission: 'platform.observe', dataClass: 'config' } },
    async (request) => {
      await requireObserver(request.context, options.permissions);

      const telephonyRead = telephonyStatus();
      const [services, nodeList, eventState, redis, nats, telephony] = await Promise.all([
        Promise.all(options.targets.map(service)),
        nodes(telephonyRead),
        events(),
        redisStore(),
        natsStore(),
        telephonyRead,
      ]);
      // MariaDB is read through telephony-config, which holds a connection to it.
      const mariadb: DataStore[] =
        options.telephonyConfigUrl === undefined
          ? []
          : [
              (telephony?.['mariadb'] as DataStore | undefined) ?? {
                name: 'mariadb',
                status: 'down',
                version: null,
                uptimeSeconds: null,
                facts: [],
              },
            ];
      return {
        checkedAt: new Date().toISOString(),
        services,
        nodes: nodeList,
        signalling: telephony?.['signalling'] ?? null,
        events: eventState,
        dataStores: [...mariadb, redis, nats],
      };
    },
  );
}

/**
 * S4-13 (G-124): what only the gateway reads, as Prometheus gauges for the console's history:
 * every durable consumer's backlog (09 §4's "consumer lag") and stream sizes, from its own NATS
 * connection, and Redis. Read once per scrape; NATS not connected yet leaves the consumer gauges
 * out.
 */
export function registerPlatformGauges(
  app: Server,
  options: { readonly bus: () => Bus | undefined; readonly redis: Redis },
): void {
  const jetstream = sharedReading(async () => {
    const bus = options.bus();
    if (bus === undefined) return { streams: [], consumers: [] };
    const streams: { name: string; messages: number; bytes: number }[] = [];
    const consumers: {
      stream: string;
      name: string;
      pending: number;
      ackPending: number;
      redelivered: number;
    }[] = [];
    for await (const stream of bus.jsm.streams.list()) {
      streams.push({
        name: stream.config.name,
        messages: stream.state.messages,
        bytes: stream.state.bytes,
      });
      for await (const consumer of bus.jsm.consumers.list(stream.config.name)) {
        if (consumer.config.durable_name === undefined) continue;
        consumers.push({
          stream: stream.config.name,
          name: consumer.config.durable_name,
          pending: consumer.num_pending,
          ackPending: consumer.num_ack_pending,
          redelivered: consumer.num_redelivered,
        });
      }
    }
    return { streams, consumers };
  });
  const consumerGauge = (
    name: string,
    description: string,
    pick: (c: { pending: number; ackPending: number; redelivered: number }) => number,
  ): void => {
    app.addGauge(name, { description }, async () =>
      (await jetstream()).consumers.map((c) => ({
        value: pick(c),
        attributes: { stream: c.stream, consumer: c.name },
      })),
    );
  };
  consumerGauge(
    'nats_consumer_pending',
    'Events a consumer has not been sent yet.',
    (c) => c.pending,
  );
  consumerGauge(
    'nats_consumer_ack_pending',
    'Events a consumer was sent and has not acknowledged.',
    (c) => c.ackPending,
  );
  consumerGauge(
    'nats_consumer_redelivered',
    'Events sent to a consumer more than once, now waiting.',
    (c) => c.redelivered,
  );
  app.addGauge('nats_stream_messages', { description: 'Events kept in a stream.' }, async () =>
    (await jetstream()).streams.map((s) => ({ value: s.messages, attributes: { stream: s.name } })),
  );

  const redisInfo = sharedReading(() => options.redis.info());
  const redisField = (info: string, name: string): number =>
    Number(new RegExp(`^${name}:(.*)$`, 'm').exec(info)?.[1]?.trim() ?? 0);
  app.addGauge(
    'redis_used_memory_bytes',
    { description: 'Memory Redis uses.', unit: 'By' },
    async () => redisField(await redisInfo(), 'used_memory'),
  );
  app.addGauge(
    'redis_connected_clients',
    { description: 'Clients connected to Redis.' },
    async () => redisField(await redisInfo(), 'connected_clients'),
  );
  app.addGauge(
    'redis_ops_per_second',
    { description: 'Commands Redis ran per second, as it measures.' },
    async () => redisField(await redisInfo(), 'instantaneous_ops_per_sec'),
  );
}
