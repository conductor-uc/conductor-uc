import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';

/**
 * A tiny in-process stand-in for FreeSWITCH's mod_event_socket, for testing
 * `createEslClient` without a real FreeSWITCH — speaks just enough of the
 * protocol (`services/call-control/src/esl/protocol.ts`) to drive the
 * client through auth, subscription, and event delivery, and to let a test
 * force-close the connection to exercise reconnect.
 */
export interface FakeEslServer {
  readonly port: number;
  /** How many client connections have completed auth+subscribe so far. */
  readyConnectionCount(): number;
  /** Sends one JSON event frame to every currently-ready connection. */
  broadcastEvent(event: Record<string, unknown>): void;
  /** Forcibly drops every open connection (simulates a node crash). */
  dropAllConnections(): void;
  /** When true, the next connection's auth request gets a rejecting reply. */
  rejectNextAuth: boolean;
  /** Every `api <command>` this server has received, in arrival order (S2-12's own `sendApi` tests). */
  readonly receivedApiCommands: readonly string[];
  /** Overrides the `api/response` body for the next `api` command received; defaults to `+OK`. */
  nextApiResponse: string;
  /**
   * S5-15: answers `api` commands by a function instead (`nextApiResponse` still wins for the
   * next one when set to something other than `+OK`).
   */
  apiResponder: ((command: string) => string) | undefined;
  /** S5-15: every `sendevent` received: the event name and its headers, in arrival order. */
  readonly receivedEvents: readonly { name: string; headers: Record<string, string> }[];
  /**
   * S5-15: when true, a `sendevent` is also delivered back to every ready connection, as
   * FreeSWITCH does for an event that names no live channel in `Unique-ID` (one that does is
   * queued to that channel instead and never reaches a listener, which is why the pause event
   * names its channel in `Recording-Call-UUID`).
   */
  echoEvents: boolean;
  close(): Promise<void>;
}

export async function startFakeEslServer(password: string): Promise<FakeEslServer> {
  const readySockets = new Set<Socket>();
  let readyCount = 0;
  let rejectNextAuth = false;
  const receivedApiCommands: string[] = [];
  let nextApiResponse = '+OK';
  let apiResponder: ((command: string) => string) | undefined;
  const receivedEvents: { name: string; headers: Record<string, string> }[] = [];
  let echoEvents = false;

  function deliver(event: Record<string, unknown>): void {
    const body = JSON.stringify(event);
    const frame = `Content-Type: text/event-json\nContent-Length: ${String(Buffer.byteLength(body))}\n\n${body}`;
    for (const socket of readySockets) socket.write(frame);
  }

  const server: Server = createServer((socket) => {
    let buffer = '';
    let authenticated = false;

    socket.write('Content-Type: auth/request\n\n');

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let frameEnd = buffer.indexOf('\n\n');
      while (frameEnd !== -1) {
        const line = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);

        if (!authenticated) {
          const provided = line.startsWith('auth ') ? line.slice(5) : '';
          if (provided === password && !rejectNextAuth) {
            authenticated = true;
            socket.write('Content-Type: command/reply\nReply-Text: +OK accepted\n\n');
          } else {
            rejectNextAuth = false;
            socket.write('Content-Type: command/reply\nReply-Text: -ERR invalid\n\n');
          }
        } else if (line.startsWith('event json')) {
          socket.write('Content-Type: command/reply\nReply-Text: +OK\n\n');
          readySockets.add(socket);
          readyCount += 1;
        } else if (line.startsWith('sendevent ')) {
          const [first = '', ...rest] = line.split('\n');
          const headers: Record<string, string> = {};
          for (const header of rest) {
            const colon = header.indexOf(':');
            if (colon > 0) headers[header.slice(0, colon).trim()] = header.slice(colon + 1).trim();
          }
          const name = first.slice('sendevent '.length).trim();
          receivedEvents.push({ name, headers });
          socket.write('Content-Type: command/reply\nReply-Text: +OK 0000-event\n\n');
          if (echoEvents) deliver({ 'Event-Name': name, ...headers });
        } else if (line.startsWith('api ')) {
          const command = line.slice(4);
          receivedApiCommands.push(command);
          const body =
            nextApiResponse === '+OK' && apiResponder !== undefined
              ? apiResponder(command)
              : nextApiResponse;
          nextApiResponse = '+OK';
          socket.write(
            `Content-Type: api/response\nContent-Length: ${String(Buffer.byteLength(body))}\n\n${body}`,
          );
        }

        frameEnd = buffer.indexOf('\n\n');
      }
    });

    socket.on('close', () => {
      readySockets.delete(socket);
    });
    socket.on('error', () => {});
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    port,
    readyConnectionCount: () => readyCount,
    broadcastEvent(event) {
      deliver(event);
    },
    dropAllConnections() {
      for (const socket of readySockets) socket.destroy();
      readySockets.clear();
    },
    get rejectNextAuth() {
      return rejectNextAuth;
    },
    set rejectNextAuth(value: boolean) {
      rejectNextAuth = value;
    },
    receivedApiCommands,
    get nextApiResponse() {
      return nextApiResponse;
    },
    set nextApiResponse(value: string) {
      nextApiResponse = value;
    },
    get apiResponder() {
      return apiResponder;
    },
    set apiResponder(value: ((command: string) => string) | undefined) {
      apiResponder = value;
    },
    receivedEvents,
    get echoEvents() {
      return echoEvents;
    },
    set echoEvents(value: boolean) {
      echoEvents = value;
    },
    async close() {
      for (const socket of readySockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
