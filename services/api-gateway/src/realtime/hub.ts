import { publishAuditEvent } from '@cuc/audit';
import type { Bus } from '@cuc/events';
import type { FastifyBaseLogger as Logger } from 'fastify';
import type { WebSocket } from 'ws';

import type { AccessTokenVerifier } from '../auth/access-token-verifier.js';
import type { RealtimeActor, TopicAuthorizer } from './authorize.js';
import {
  callEventFromEnvelope,
  type BusEnvelope,
  type CallTopicEvent,
  type LiveCall,
} from './calls.js';
import { startEventFeed, type EventFeed } from './feed.js';
import { TenantPresence } from './presence.js';
import {
  CLOSE,
  ERROR_MESSAGES,
  parseClientMessage,
  PROTOCOL_VERSION,
  type CloseSpec,
  type ErrorCode,
} from './protocol.js';
import type { LiveCallsSource, UserExtensionSource } from './sources.js';
import { parseTopic, TOPICS, topicName, type Topic } from './topics.js';
import { UserCalls } from './user-calls.js';

export interface RealtimeLimits {
  readonly authTimeoutMs: number;
  readonly maxConnectionsPerIp: number;
  readonly maxConnectionsPerUser: number;
  readonly maxSubscriptions: number;
  readonly maxMessagesPerMinute: number;
  readonly maxBufferedBytes: number;
  readonly heartbeatIntervalMs: number;
  readonly permissionRecheckMs: number;
}

/** A private-class subscription, as it is audited (07 §4: every private read is). */
export interface SubscriptionAuditEntry {
  readonly actor: RealtimeActor;
  readonly topic: Topic;
  readonly ip: string;
  readonly requestId?: string;
}

export interface RealtimeHubOptions {
  readonly verifier: AccessTokenVerifier;
  readonly authorizer: TopicAuthorizer;
  readonly liveCalls: LiveCallsSource;
  /**
   * S5-15: a person's own extension number, for their `user:{u}:calls` topic.
   * Without it that topic is refused as `unavailable`.
   */
  readonly userExtensions?: UserExtensionSource;
  readonly logger: Logger;
  readonly limits: RealtimeLimits;
  /**
   * Records a private-class subscription. Defaults to publishing an
   * `audit.event.recorded` on the attached bus (`@cuc/audit`'s direct publish,
   * as for every other read). Throws when it cannot; the subscription is then
   * refused, as a service refuses a private read it cannot audit.
   */
  readonly audit?: (entry: SubscriptionAuditEntry) => Promise<void>;
  readonly now?: () => number;
}

export interface ConnectionMeta {
  /** The client address (the proxy-aware one, TRUSTED_PROXIES). */
  readonly ip: string;
  readonly requestId?: string;
}

export interface RealtimeHub {
  /** False when the address already holds its limit of connections; checked before the upgrade. */
  canAccept(ip: string): boolean;
  /** Takes over an upgraded socket. */
  accept(socket: WebSocket, meta: ConnectionMeta): void;
  /** Starts reading events from NATS. Until then, and whenever the feed is down, subscriptions are refused as `unavailable`. */
  attachBus(bus: Bus): void;
  /** Fans one event out, as the feed does. Exposed for the feed and for tests. */
  dispatch(envelope: BusEnvelope): void;
  readonly connectionCount: number;
  /** Whether events are being read from NATS now. */
  readonly feedLive: boolean;
  /** Closes every connection (1001) and stops the feed and timers. */
  close(): Promise<void>;
}

interface Subscription {
  readonly topic: Topic;
  readonly id: string | undefined;
  /** False until its snapshot is sent; events meanwhile wait in `pending`, so the stream stays in order. */
  ready: boolean;
  readonly pending: string[];
  /** The presence tracker this subscription holds a share of (presence topics only). */
  tracker?: PresenceTracker;
  /** S5-15: a person's own calls (`mycalls` topics only): the tenant's legs, and which of them this subscriber is shown. */
  own?: { readonly calls: CallsTracker; view: UserCalls | undefined };
}

interface Connection {
  readonly socket: WebSocket;
  readonly meta: ConnectionMeta;
  readonly subscriptions: Map<string, Subscription>;
  /**
   * Subscribes still being authorized or audited, by topic name. A later
   * subscribe or unsubscribe for the same topic replaces or removes the entry,
   * and the earlier attempt then gives up instead of creating the subscription.
   */
  readonly inFlight: Map<string, symbol>;
  actor: RealtimeActor | undefined;
  authTimer: NodeJS.Timeout | undefined;
  expiryTimer: NodeJS.Timeout | undefined;
  alive: boolean;
  closing: boolean;
  windowStart: number;
  messagesInWindow: number;
}

interface PresenceTracker {
  readonly presence: TenantPresence;
  loaded: boolean;
  readonly pending: CallTopicEvent[];
  readonly ready: Promise<boolean>;
  subscribers: number;
}

/**
 * S5-15: every live leg of a tenant, kept while someone on this gateway
 * watches their own calls in it: which legs a person is shown depends on the
 * legs bridged to theirs, so the hub needs the whole picture, as presence does.
 */
interface CallsTracker {
  readonly legs: Map<string, LiveCall>;
  loaded: boolean;
  readonly pending: CallTopicEvent[];
  readonly ready: Promise<boolean>;
  subscribers: number;
}

/** What {@link ownNumber} answers instead of a number: an extension number is digits, so neither can be one. */
const UNAVAILABLE = 'unavailable';
const NO_EXTENSION = 'no_linked_extension';

/** The longest a Node timer may wait. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The realtime hub (06, api-gateway; S5-08): WebSocket connections, their
 * subscriptions, and the fan-out of live events to them.
 *
 * Every connection authenticates with an access token and keeps doing so
 * before it expires. Every subscription is authorized like an HTTP request
 * (`authorize.ts`) when made and again every `permissionRecheckMs`, so a role
 * taken away ends the stream. Events come from NATS (`feed.ts`), are mapped to
 * the topic they belong to by tenant, and are sent only to that topic's
 * subscribers, as only what the topic's permission covers (`calls.ts`,
 * `presence.ts`).
 *
 * All state is this process's own: several gateway replicas each run a hub,
 * each reads every event, and each serves only its own sockets. Nothing needs
 * sticky sessions; a client that reconnects to another replica subscribes
 * again and gets a fresh snapshot.
 */
export function createRealtimeHub(options: RealtimeHubOptions): RealtimeHub {
  const { limits, logger } = options;
  const now = options.now ?? Date.now;
  const connections = new Set<Connection>();
  const perIp = new Map<string, number>();
  const perUser = new Map<string, number>();
  /** Topic name → the connections subscribed to it. */
  const subscribers = new Map<string, Set<Connection>>();
  const presenceTrackers = new Map<string, PresenceTracker>();
  const callsTrackers = new Map<string, CallsTracker>();
  /** S5-15: tenant to the `mycalls` topic names subscribed to on this gateway. */
  const userTopics = new Map<string, Set<string>>();
  let bus: Bus | undefined;
  let feed: EventFeed | undefined;
  let feedWasLive = false;
  let closed = false;

  const audit =
    options.audit ??
    (async (entry: SubscriptionAuditEntry) => {
      if (bus === undefined) throw new Error('No bus to audit on.');
      await publishAuditEvent(bus, {
        actorType: 'user',
        actorId: entry.actor.id,
        actorOrgId: entry.actor.orgId,
        targetOrgId: entry.topic.tenantId,
        action: `realtime.${entry.topic.kind}.subscribed`,
        resource: entry.topic.name,
        dataClass: TOPICS[entry.topic.kind].dataClass,
        ip: entry.ip,
        ...(entry.requestId === undefined ? {} : { requestId: entry.requestId }),
      });
    });

  const heartbeat = setInterval(() => {
    for (const connection of connections) {
      if (!connection.alive) {
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      try {
        connection.socket.ping();
      } catch {
        connection.socket.terminate();
      }
    }
  }, limits.heartbeatIntervalMs);
  heartbeat.unref();

  const recheck = setInterval(() => {
    for (const connection of connections) void recheckSubscriptions(connection);
  }, limits.permissionRecheckMs);
  recheck.unref();

  // The feed going down means events may be missed, so no subscriber's view
  // can be trusted any more: each is ended as `unavailable`, and the client
  // subscribes again (with a fresh snapshot) once the feed is back.
  const feedWatch = setInterval(() => {
    const live = feed?.live ?? false;
    if (feedWasLive && !live) {
      logger.warn('realtime feed lost; ending every subscription');
      for (const connection of connections) {
        for (const name of [...connection.subscriptions.keys()]) {
          endSubscription(connection, name, 'unavailable');
        }
      }
    }
    feedWasLive = live;
  }, 1_000);
  feedWatch.unref();

  function send(connection: Connection, message: object | string): void {
    const { socket } = connection;
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > limits.maxBufferedBytes) {
      closeConnection(connection, CLOSE.slowConnection);
      return;
    }
    socket.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  function sendError(
    connection: Connection,
    code: ErrorCode,
    extra: { topic?: string; id?: string | undefined } = {},
  ): void {
    send(connection, {
      type: 'error',
      code,
      message: ERROR_MESSAGES[code],
      ...(extra.topic === undefined ? {} : { topic: extra.topic }),
      ...(extra.id === undefined ? {} : { id: extra.id }),
    });
  }

  function closeConnection(connection: Connection, spec: CloseSpec): void {
    if (connection.closing) return;
    connection.closing = true;
    connection.socket.close(spec.code, spec.reason);
    // A peer that never answers the closing handshake is let go of anyway.
    setTimeout(() => connection.socket.terminate(), 5_000).unref();
  }

  function userKey(actor: RealtimeActor): string {
    return `${actor.orgId}:${actor.id}`;
  }

  function cleanup(connection: Connection): void {
    if (!connections.delete(connection)) return;
    clearTimeout(connection.authTimer);
    clearTimeout(connection.expiryTimer);
    for (const name of [...connection.subscriptions.keys()]) removeSubscription(connection, name);
    connection.inFlight.clear();
    decrement(perIp, connection.meta.ip);
    if (connection.actor !== undefined) decrement(perUser, userKey(connection.actor));
  }

  function decrement(map: Map<string, number>, key: string): void {
    const count = (map.get(key) ?? 1) - 1;
    if (count <= 0) map.delete(key);
    else map.set(key, count);
  }

  function removeSubscription(connection: Connection, name: string): Subscription | undefined {
    const subscription = connection.subscriptions.get(name);
    if (subscription === undefined) return undefined;
    connection.subscriptions.delete(name);
    const set = subscribers.get(name);
    set?.delete(connection);
    if (set?.size === 0) subscribers.delete(name);
    if (subscription.tracker !== undefined) {
      releasePresence(subscription.topic.tenantId, subscription.tracker);
    }
    if (subscription.own !== undefined) {
      releaseCalls(subscription.topic.tenantId, subscription.own.calls);
      if (set === undefined || set.size === 0) {
        const names = userTopics.get(subscription.topic.tenantId);
        names?.delete(name);
        if (names?.size === 0) userTopics.delete(subscription.topic.tenantId);
      }
    }
    return subscription;
  }

  /** Ends a subscription the client did not ask to end, telling it why. */
  function endSubscription(connection: Connection, name: string, code: ErrorCode): void {
    const subscription = removeSubscription(connection, name);
    if (subscription === undefined) return;
    send(connection, { type: 'unsubscribed', topic: name, code });
  }

  function releasePresence(tenantId: string, tracker: PresenceTracker): void {
    tracker.subscribers -= 1;
    if (tracker.subscribers <= 0 && presenceTrackers.get(tenantId) === tracker) {
      presenceTrackers.delete(tenantId);
    }
  }

  function acquirePresence(tenantId: string): PresenceTracker {
    const existing = presenceTrackers.get(tenantId);
    if (existing !== undefined) {
      existing.subscribers += 1;
      return existing;
    }
    const presence = new TenantPresence();
    const pending: CallTopicEvent[] = [];
    const tracker: PresenceTracker = {
      presence,
      loaded: false,
      pending,
      subscribers: 1,
      ready: options
        .liveCalls(tenantId)
        .then((calls) => {
          presence.load(calls);
          for (const event of pending) presence.apply(event);
          pending.length = 0;
          tracker.loaded = true;
          return true;
        })
        .catch((error: unknown) => {
          logger.warn({ err: error, tenantId }, 'presence snapshot unavailable');
          if (presenceTrackers.get(tenantId) === tracker) presenceTrackers.delete(tenantId);
          return false;
        }),
    };
    presenceTrackers.set(tenantId, tracker);
    return tracker;
  }

  function releaseCalls(tenantId: string, tracker: CallsTracker): void {
    tracker.subscribers -= 1;
    if (tracker.subscribers <= 0 && callsTrackers.get(tenantId) === tracker) {
      callsTrackers.delete(tenantId);
    }
  }

  function acquireCalls(tenantId: string): CallsTracker {
    const existing = callsTrackers.get(tenantId);
    if (existing !== undefined) {
      existing.subscribers += 1;
      return existing;
    }
    const legs = new Map<string, LiveCall>();
    const pending: CallTopicEvent[] = [];
    const tracker: CallsTracker = {
      legs,
      loaded: false,
      pending,
      subscribers: 1,
      ready: options
        .liveCalls(tenantId)
        .then((calls) => {
          for (const call of calls) legs.set(call.callUuid, call);
          for (const event of pending) applyToLegs(legs, event);
          pending.length = 0;
          tracker.loaded = true;
          return true;
        })
        .catch((error: unknown) => {
          logger.warn({ err: error, tenantId }, 'live calls unavailable for own calls');
          if (callsTrackers.get(tenantId) === tracker) callsTrackers.delete(tenantId);
          return false;
        }),
    };
    callsTrackers.set(tenantId, tracker);
    return tracker;
  }

  /** A person's own extension number, or the error to refuse their topic with. */
  async function ownNumber(topic: Topic): Promise<string> {
    if (options.userExtensions === undefined || topic.userId === undefined) return UNAVAILABLE;
    try {
      return (await options.userExtensions(topic.tenantId, topic.userId)) ?? NO_EXTENSION;
    } catch (error) {
      logger.warn({ err: error, topic: topic.name }, 'own extension unavailable');
      return UNAVAILABLE;
    }
  }

  async function handleAuth(connection: Connection, token: string): Promise<void> {
    let claims;
    try {
      claims = await options.verifier.verify(token);
    } catch {
      closeConnection(connection, CLOSE.invalidToken);
      return;
    }
    const expiresAtMs = typeof claims.exp === 'number' ? claims.exp * 1000 : undefined;
    if (expiresAtMs === undefined || expiresAtMs <= now()) {
      closeConnection(connection, CLOSE.invalidToken);
      return;
    }
    const actor: RealtimeActor = { id: claims.sub, orgId: claims.org, orgType: claims.ot };

    if (connection.actor === undefined) {
      const key = userKey(actor);
      if ((perUser.get(key) ?? 0) >= limits.maxConnectionsPerUser) {
        closeConnection(connection, CLOSE.tooManyConnections);
        return;
      }
      perUser.set(key, (perUser.get(key) ?? 0) + 1);
      clearTimeout(connection.authTimer);
      connection.authTimer = undefined;
    } else if (
      connection.actor.id !== actor.id ||
      connection.actor.orgId !== actor.orgId ||
      connection.actor.orgType !== actor.orgType
    ) {
      closeConnection(connection, CLOSE.identityChanged);
      return;
    }
    const renewed = connection.actor !== undefined;
    connection.actor = actor;

    clearTimeout(connection.expiryTimer);
    connection.expiryTimer = setTimeout(
      () => closeConnection(connection, CLOSE.sessionExpired),
      Math.min(expiresAtMs - now(), MAX_TIMER_MS),
    );
    send(connection, {
      type: 'authenticated',
      v: PROTOCOL_VERSION,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
    // A new token may come with different permissions: check at once.
    if (renewed) void recheckSubscriptions(connection);
  }

  async function handleSubscribe(
    connection: Connection,
    actor: RealtimeActor,
    name: string,
    id: string | undefined,
  ): Promise<void> {
    const topic = parseTopic(name);
    if (topic === undefined) {
      sendError(connection, 'unknown_topic', { topic: name, id });
      return;
    }
    // Subscribing again to the same topic replaces it: a way to get a fresh snapshot.
    removeSubscription(connection, name);
    // Subscribes still in flight count too, so a burst of them cannot pass the limit together.
    const inFlightOthers = connection.inFlight.size - (connection.inFlight.has(name) ? 1 : 0);
    if (connection.subscriptions.size + inFlightOthers >= limits.maxSubscriptions) {
      sendError(connection, 'too_many_subscriptions', { topic: name, id });
      return;
    }
    const attempt = Symbol(name);
    connection.inFlight.set(name, attempt);
    /** False once this attempt was superseded, cancelled by an unsubscribe, or its connection closed. */
    const current = () => connections.has(connection) && connection.inFlight.get(name) === attempt;

    const verdict = await options.authorizer.authorize(actor, topic);
    if (!current()) return;
    if (!verdict.allowed) {
      connection.inFlight.delete(name);
      logger.info(
        { topic: name, code: verdict.code, actorOrgId: actor.orgId },
        'realtime subscription refused',
      );
      sendError(connection, verdict.code, { topic: name, id });
      return;
    }
    if (feed?.live !== true) {
      connection.inFlight.delete(name);
      sendError(connection, 'unavailable', { topic: name, id });
      return;
    }
    if (TOPICS[topic.kind].dataClass === 'private') {
      try {
        await audit({
          actor,
          topic,
          ip: connection.meta.ip,
          ...(connection.meta.requestId === undefined
            ? {}
            : { requestId: connection.meta.requestId }),
        });
      } catch (error) {
        logger.error(
          { err: error, topic: name },
          'could not audit a private subscription; refused',
        );
        if (connection.inFlight.get(name) === attempt) connection.inFlight.delete(name);
        sendError(connection, 'unavailable', { topic: name, id });
        return;
      }
    }
    if (!current()) return;
    connection.inFlight.delete(name);
    if (connection.subscriptions.size >= limits.maxSubscriptions) {
      sendError(connection, 'too_many_subscriptions', { topic: name, id });
      return;
    }

    const subscription: Subscription = { topic, id, ready: false, pending: [] };
    connection.subscriptions.set(name, subscription);
    let set = subscribers.get(name);
    if (set === undefined) {
      set = new Set();
      subscribers.set(name, set);
    }
    set.add(connection);

    let snapshot: object | undefined;
    switch (topic.kind) {
      case 'calls': {
        try {
          snapshot = { calls: await options.liveCalls(topic.tenantId) };
        } catch (error) {
          logger.warn({ err: error, topic: name }, 'live calls snapshot unavailable');
          snapshot = undefined;
        }
        if (snapshot === undefined) {
          if (connection.subscriptions.get(name) === subscription) {
            removeSubscription(connection, name);
            sendError(connection, 'unavailable', { topic: name, id });
          }
          return;
        }
        break;
      }
      case 'presence': {
        const tracker = acquirePresence(topic.tenantId);
        subscription.tracker = tracker;
        const loaded = await tracker.ready;
        if (connection.subscriptions.get(name) !== subscription) return;
        if (!loaded) {
          removeSubscription(connection, name);
          sendError(connection, 'unavailable', { topic: name, id });
          return;
        }
        snapshot = { extensions: tracker.presence.snapshot() };
        break;
      }
      case 'queues':
        // Nothing to start from yet (see topics.ts).
        break;
      case 'mycalls': {
        // S5-15: the person's own extension, then the tenant's legs, then theirs among them.
        let names = userTopics.get(topic.tenantId);
        if (names === undefined) {
          names = new Set();
          userTopics.set(topic.tenantId, names);
        }
        names.add(name);
        const own: NonNullable<Subscription['own']> = {
          calls: acquireCalls(topic.tenantId),
          view: undefined,
        };
        subscription.own = own;
        const number = await ownNumber(topic);
        const loaded = await own.calls.ready;
        if (connection.subscriptions.get(name) !== subscription) return;
        if (!loaded || number === UNAVAILABLE || number === NO_EXTENSION) {
          removeSubscription(connection, name);
          sendError(
            connection,
            loaded && number === NO_EXTENSION ? 'no_linked_extension' : 'unavailable',
            {
              topic: name,
              id,
            },
          );
          return;
        }
        const view = new UserCalls(number);
        own.view = view;
        snapshot = { calls: view.load(own.calls.legs) };
        break;
      }
    }

    // Unsubscribed, replaced, or closed while the snapshot was on its way.
    if (connection.subscriptions.get(name) !== subscription) return;
    send(connection, { type: 'subscribed', topic: name, ...(id === undefined ? {} : { id }) });
    if (snapshot !== undefined) send(connection, { type: 'snapshot', topic: name, data: snapshot });
    for (const message of subscription.pending) send(connection, message);
    subscription.pending.length = 0;
    subscription.ready = true;
  }

  async function recheckSubscriptions(connection: Connection): Promise<void> {
    const actor = connection.actor;
    if (actor === undefined) return;
    for (const [name, subscription] of [...connection.subscriptions]) {
      const verdict = await options.authorizer.authorize(actor, subscription.topic);
      if (connection.subscriptions.get(name) !== subscription) continue;
      if (!verdict.allowed) {
        logger.info({ topic: name, code: verdict.code }, 'realtime subscription ended');
        endSubscription(connection, name, verdict.code);
        continue;
      }
      // S5-15: a person's extension may have been unlinked or changed. Their view was built for
      // the old one; ending it (the client subscribes again) gives them a fresh, right one.
      const view = subscription.own?.view;
      if (view !== undefined) {
        const number = await ownNumber(subscription.topic);
        if (connection.subscriptions.get(name) !== subscription) continue;
        if (number !== view.number && number !== UNAVAILABLE) {
          logger.info({ topic: name }, 'own extension changed; subscription ended');
          endSubscription(
            connection,
            name,
            number === NO_EXTENSION ? 'no_linked_extension' : 'unavailable',
          );
        }
      }
    }
  }

  function onMessage(connection: Connection, data: Buffer, isBinary: boolean): void {
    if (connection.closing) return;
    const at = now();
    if (at - connection.windowStart >= 60_000) {
      connection.windowStart = at;
      connection.messagesInWindow = 0;
    }
    connection.messagesInWindow += 1;
    if (connection.messagesInWindow > limits.maxMessagesPerMinute) {
      closeConnection(connection, CLOSE.tooManyMessages);
      return;
    }

    const parsed = isBinary
      ? ({ ok: false, code: 'bad_message' } as const)
      : parseClientMessage(data.toString('utf8'));
    if (!parsed.ok) {
      if (connection.actor === undefined) closeConnection(connection, CLOSE.authRequired);
      else sendError(connection, parsed.code, { id: parsed.id });
      return;
    }
    const { message } = parsed;
    if (message.type === 'auth') {
      void handleAuth(connection, message.token).catch((error: unknown) => {
        logger.error({ err: error }, 'realtime auth failed');
        closeConnection(connection, CLOSE.invalidToken);
      });
      return;
    }
    // Nothing but `auth` before the connection is authenticated.
    const actor = connection.actor;
    if (actor === undefined) {
      closeConnection(connection, CLOSE.authRequired);
      return;
    }
    if (message.type === 'subscribe') {
      void handleSubscribe(connection, actor, message.topic, message.id).catch((error: unknown) => {
        logger.error({ err: error, topic: message.topic }, 'realtime subscribe failed');
        removeSubscription(connection, message.topic);
        sendError(connection, 'unavailable', { topic: message.topic, id: message.id });
      });
      return;
    }
    // An unsubscribe also cancels a subscribe for the topic that is still being authorized.
    const cancelled = connection.inFlight.delete(message.topic);
    const removed = removeSubscription(connection, message.topic);
    if (removed === undefined && !cancelled) {
      sendError(connection, 'not_subscribed', { topic: message.topic, id: message.id });
      return;
    }
    send(connection, {
      type: 'unsubscribed',
      topic: message.topic,
      ...(message.id === undefined ? {} : { id: message.id }),
    });
  }

  function deliver(name: string, event: object): void {
    const set = subscribers.get(name);
    if (set === undefined || set.size === 0) return;
    const message = JSON.stringify({ type: 'event', topic: name, event });
    for (const connection of set) {
      const subscription = connection.subscriptions.get(name);
      if (subscription === undefined) continue;
      if (subscription.ready) send(connection, message);
      else subscription.pending.push(message);
    }
  }

  /** Sends to one subscription, after its snapshot. */
  function deliverTo(connection: Connection, subscription: Subscription, event: object): void {
    const message = JSON.stringify({ type: 'event', topic: subscription.topic.name, event });
    if (subscription.ready) send(connection, message);
    else subscription.pending.push(message);
  }

  /** S5-15: a change to the tenant's legs, and what each person watching their own calls in it is shown of it. */
  function dispatchOwn(tenantId: string, event: CallTopicEvent): void {
    const tracker = callsTrackers.get(tenantId);
    if (tracker === undefined) return;
    if (!tracker.loaded) {
      tracker.pending.push(event);
      return;
    }
    applyToLegs(tracker.legs, event);
    for (const name of userTopics.get(tenantId) ?? []) {
      for (const connection of subscribers.get(name) ?? []) {
        const subscription = connection.subscriptions.get(name);
        const view = subscription?.own?.view;
        if (subscription === undefined || view === undefined) continue;
        for (const change of view.apply(tracker.legs, event)) {
          deliverTo(connection, subscription, change);
        }
      }
    }
  }

  function dispatch(envelope: BusEnvelope): void {
    const mapped = callEventFromEnvelope(envelope);
    if (mapped === undefined) return;
    const { tenantId, event } = mapped;
    deliver(topicName(tenantId, 'calls'), event);
    dispatchOwn(tenantId, event);

    const tracker = presenceTrackers.get(tenantId);
    if (tracker === undefined) return;
    if (!tracker.loaded) {
      tracker.pending.push(event);
      return;
    }
    for (const change of tracker.presence.apply(event)) {
      deliver(topicName(tenantId, 'presence'), change);
    }
  }

  return {
    canAccept(ip) {
      return !closed && (perIp.get(ip) ?? 0) < limits.maxConnectionsPerIp;
    },

    accept(socket, meta) {
      const connection: Connection = {
        socket,
        meta,
        subscriptions: new Map(),
        inFlight: new Map(),
        actor: undefined,
        authTimer: undefined,
        expiryTimer: undefined,
        alive: true,
        closing: false,
        windowStart: now(),
        messagesInWindow: 0,
      };
      connections.add(connection);
      perIp.set(meta.ip, (perIp.get(meta.ip) ?? 0) + 1);
      socket.on('close', () => cleanup(connection));
      socket.on('error', () => cleanup(connection));
      socket.on('pong', () => {
        connection.alive = true;
      });
      socket.on('message', (data, isBinary) => {
        onMessage(connection, data as Buffer, isBinary);
      });

      if (closed) {
        closeConnection(connection, CLOSE.goingAway);
        return;
      }
      // The upgrade checked the limit, but two upgrades can race past it.
      if ((perIp.get(meta.ip) ?? 0) > limits.maxConnectionsPerIp) {
        closeConnection(connection, CLOSE.tooManyConnections);
        return;
      }
      connection.authTimer = setTimeout(() => {
        if (connection.actor === undefined) closeConnection(connection, CLOSE.authRequired);
      }, limits.authTimeoutMs);
    },

    attachBus(attached) {
      if (bus !== undefined || closed) return;
      bus = attached;
      feed = startEventFeed({ bus: attached, logger, onEvent: dispatch });
    },

    dispatch,

    get connectionCount() {
      return connections.size;
    },

    get feedLive() {
      return feed?.live ?? false;
    },

    async close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearInterval(recheck);
      clearInterval(feedWatch);
      for (const connection of connections) closeConnection(connection, CLOSE.goingAway);
      await feed?.stop();
    },
  };
}

/** Applies one change to a tenant's legs. */
function applyToLegs(legs: Map<string, LiveCall>, event: CallTopicEvent): void {
  switch (event.type) {
    case 'call.started':
      legs.set(event.call.callUuid, event.call);
      return;
    case 'call.updated': {
      const leg = legs.get(event.callUuid);
      if (leg !== undefined) legs.set(event.callUuid, { ...leg, ...event.changes });
      return;
    }
    case 'call.ended':
      legs.delete(event.callUuid);
      return;
  }
}
