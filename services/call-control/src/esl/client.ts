import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';

import type { Logger } from '@cuc/logger';

import { EslFrameParser, eslCommand, isOkReply } from './protocol.js';
import type { EslFrame } from './protocol.js';

export interface FsNodeAddress {
  readonly id: string;
  readonly host: string;
  readonly port: number;
}

export interface EslClientOptions {
  readonly node: FsNodeAddress;
  readonly password: string;
  readonly logger: Logger;
  readonly reconnectMinDelayMs: number;
  readonly reconnectMaxDelayMs: number;
  /** One normalized ESL event, raw (still `variable_`-prefixed keys etc.) — `normalize.ts` does the actual mapping. */
  readonly onEvent: (nodeId: string, event: Record<string, string>) => void;
  readonly onConnect?: (nodeId: string) => void;
  readonly onDisconnect?: (nodeId: string) => void;
  /** Overridable for tests, so `test/esl-client.test.ts` can point this at an in-process fake server without touching real sockets elsewhere. */
  readonly connect?: (port: number, host: string) => Socket;
}

export interface EslClient {
  /** Connects and begins the reconnect loop. Idempotent. */
  start(): void;
  /** Stops reconnecting and closes any open connection. */
  stop(): Promise<void>;
}

const SUBSCRIBE_COMMAND =
  'event json CHANNEL_CREATE CHANNEL_ANSWER CHANNEL_BRIDGE CHANNEL_HOLD CHANNEL_HANGUP_COMPLETE HEARTBEAT';

type ConnectionState = 'connecting' | 'authenticating' | 'subscribing' | 'ready';

/**
 * One ESL inbound-mode connection to one FreeSWITCH node, with reconnect.
 *
 * Protocol flow (mod_event_socket, inbound connection mode): the server
 * sends an `auth/request` frame unprompted; the client replies `auth
 * <password>`; on `+OK` the client subscribes to the channel events it
 * cares about with `event json ...`; every frame after that with
 * `Content-Type: text/event-json` is one normalized event, delivered via
 * `onEvent`.
 */
export function createEslClient(options: EslClientOptions): EslClient {
  const {
    node,
    password,
    logger,
    reconnectMinDelayMs,
    reconnectMaxDelayMs,
    onEvent,
    onConnect,
    onDisconnect,
  } = options;
  const connectFn = options.connect ?? ((port: number, host: string) => netConnect(port, host));

  let stopped = true;
  let socket: Socket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectDelay = reconnectMinDelayMs;
  let state: ConnectionState = 'connecting';
  let wasConnected = false;

  function scheduleReconnect(): void {
    if (stopped) return;
    reconnectTimer = setTimeout(() => {
      connectOnce();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, reconnectMaxDelayMs);
  }

  function handleFrame(frame: EslFrame): void {
    const contentType = frame.headers.get('Content-Type') ?? '';

    if (state === 'connecting' && contentType === 'auth/request') {
      state = 'authenticating';
      socket?.write(eslCommand(`auth ${password}`));
      return;
    }

    if (state === 'authenticating' && contentType === 'command/reply') {
      if (!isOkReply(frame)) {
        logger.error({ nodeId: node.id }, 'ESL auth rejected');
        socket?.destroy();
        return;
      }
      state = 'subscribing';
      socket?.write(eslCommand(SUBSCRIBE_COMMAND));
      return;
    }

    if (state === 'subscribing' && contentType === 'command/reply') {
      if (!isOkReply(frame)) {
        logger.error({ nodeId: node.id }, 'ESL event subscription rejected');
        socket?.destroy();
        return;
      }
      state = 'ready';
      reconnectDelay = reconnectMinDelayMs;
      wasConnected = true;
      logger.info({ nodeId: node.id }, 'ESL connected and subscribed');
      onConnect?.(node.id);
      return;
    }

    if (contentType === 'text/disconnect-notice') {
      socket?.end();
      return;
    }

    if (contentType === 'text/event-json' && frame.body !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(frame.body);
      } catch (error) {
        logger.warn({ nodeId: node.id, err: error }, 'unparseable ESL event body; dropped');
        return;
      }
      if (typeof parsed === 'object' && parsed !== null) {
        onEvent(node.id, parsed as Record<string, string>);
      }
      return;
    }

    // command/reply frames for commands this client never sends (none yet)
    // and anything else unrecognized are ignored rather than treated as an
    // error — a strange or future FreeSWITCH event type must not take the
    // connection down.
  }

  function connectOnce(): void {
    if (stopped) return;
    reconnectTimer = undefined;
    state = 'connecting';
    wasConnected = false;

    const parser = new EslFrameParser();
    let sock: Socket;
    try {
      sock = connectFn(node.port, node.host);
    } catch (error) {
      logger.warn({ nodeId: node.id, err: error }, 'ESL connection attempt failed');
      scheduleReconnect();
      return;
    }
    socket = sock;

    sock.on('data', (chunk: Buffer) => {
      for (const frame of parser.push(chunk)) handleFrame(frame);
    });

    sock.on('error', (error) => {
      logger.warn({ nodeId: node.id, err: error }, 'ESL socket error');
    });

    sock.on('close', () => {
      if (socket === sock) socket = undefined;
      if (wasConnected) onDisconnect?.(node.id);
      scheduleReconnect();
    });
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      connectOnce();
    },

    stop() {
      stopped = true;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      socket?.destroy();
      socket = undefined;
      return Promise.resolve();
    },
  };
}
