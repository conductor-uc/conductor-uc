/**
 * The realtime protocol spoken on `GET /v1/ws` (S5-08), version 1.
 *
 * Every frame is one JSON text message with a `type`. The client authenticates
 * with its first message (browsers cannot set `Authorization` on a WebSocket,
 * and a token in the URL would end up in access logs), then subscribes to
 * topics. Documented for clients in docs/architecture/06-services.md
 * (api-gateway, "Realtime hub"); change the two together.
 *
 * Client to server:
 *
 * - `{type:"auth", token}`: the access token. First message, within
 *   `REALTIME_AUTH_TIMEOUT_MS`; sent again with a fresh token before the old
 *   one expires, or the connection is closed when it does.
 * - `{type:"subscribe", topic, id?}` / `{type:"unsubscribe", topic, id?}`.
 *   `id` is echoed on the answer, for a client that wants to match them.
 *
 * Server to client:
 *
 * - `{type:"authenticated", v, expiresAt}` after each accepted `auth`.
 * - `{type:"subscribed", topic, id?}`, then for topics that have one a
 *   `{type:"snapshot", topic, data}`, then `{type:"event", topic, event}` for
 *   each change after it, in order.
 * - `{type:"unsubscribed", topic, id?, code?}`: after an `unsubscribe`, or
 *   (with `code`) when the server ends a subscription, such as when a
 *   permission is taken away (`permission_denied`) or the event source failed
 *   (`unavailable`: subscribing again later may work).
 * - `{type:"error", code, message, topic?, id?}`: a request that was refused.
 *
 * Nothing here names the product or the operator: codes and reasons are plain
 * and neutral (CLAUDE.md rule 1).
 */

export const PROTOCOL_VERSION = 1;

/**
 * Close codes. 1000–1015 are the standard ones; 4000–4999 are the
 * application's own (RFC 6455 §7.4.2). A client should get a fresh access
 * token before reconnecting after a 4401, and should not reconnect after a
 * 4403 without the user signing in again.
 */
export const CLOSE = {
  /** The server is shutting down; reconnect (another replica will answer). */
  goingAway: { code: 1001, reason: 'Server shutting down' },
  /** A protocol violation: too many messages, or a malformed frame. */
  tooManyMessages: { code: 1008, reason: 'Too many messages' },
  /** The client fell too far behind (its unsent data passed the limit). */
  slowConnection: { code: 1013, reason: 'Connection too slow' },
  /** A connection limit (per address or per person) was reached. */
  tooManyConnections: { code: 1013, reason: 'Too many connections' },
  /** No valid access token in time: send `auth` first. */
  authRequired: { code: 4401, reason: 'Authentication required' },
  /** The access token was not valid. */
  invalidToken: { code: 4401, reason: 'Invalid token' },
  /** The access token expired without being replaced. */
  sessionExpired: { code: 4401, reason: 'Session expired' },
  /** A later token named a different person or organization. */
  identityChanged: { code: 4403, reason: 'Identity changed' },
} as const;

export type CloseSpec = (typeof CLOSE)[keyof typeof CLOSE];

/** Every `code` an `error` or `unsubscribed` message can carry. */
export type ErrorCode =
  | 'bad_message'
  | 'unknown_type'
  | 'unknown_topic'
  | 'not_subscribed'
  | 'too_many_subscriptions'
  /** Tenant boundary (H2) or org ancestry: the topic's tenant is not one this person may reach. */
  | 'forbidden'
  /** H1: a reseller asked for a private-class topic. */
  | 'reseller_private_data_denied'
  /** The person does not hold the topic's permission (any more). */
  | 'permission_denied'
  /** Something the hub depends on could not be reached; try again later. */
  | 'unavailable';

export type ClientMessage =
  | { readonly type: 'auth'; readonly token: string }
  | { readonly type: 'subscribe'; readonly topic: string; readonly id?: string }
  | { readonly type: 'unsubscribe'; readonly topic: string; readonly id?: string };

export type ParseResult =
  | { readonly ok: true; readonly message: ClientMessage }
  | { readonly ok: false; readonly code: 'bad_message' | 'unknown_type'; readonly id?: string };

const MAX_TOKEN_LENGTH = 8_192;
const MAX_TOPIC_LENGTH = 200;
const MAX_ID_LENGTH = 64;

/** Parses one client frame. Anything not exactly one of {@link ClientMessage} is refused. */
export function parseClientMessage(raw: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'bad_message' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, code: 'bad_message' };
  }
  const record = value as Record<string, unknown>;
  const id = record['id'];
  if (id !== undefined && (typeof id !== 'string' || id.length > MAX_ID_LENGTH)) {
    return { ok: false, code: 'bad_message' };
  }
  const withId = id === undefined ? {} : { id };

  switch (record['type']) {
    case 'auth': {
      const token = record['token'];
      if (typeof token !== 'string' || token === '' || token.length > MAX_TOKEN_LENGTH) {
        return { ok: false, code: 'bad_message', ...withId };
      }
      return { ok: true, message: { type: 'auth', token } };
    }
    case 'subscribe':
    case 'unsubscribe': {
      const topic = record['topic'];
      if (typeof topic !== 'string' || topic === '' || topic.length > MAX_TOPIC_LENGTH) {
        return { ok: false, code: 'bad_message', ...withId };
      }
      return { ok: true, message: { type: record['type'], topic, ...withId } };
    }
    default:
      return { ok: false, code: 'unknown_type', ...withId };
  }
}

/** The human-readable text sent with each error code. Plain, and never naming the product. */
export const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  bad_message: 'The message could not be understood.',
  unknown_type: 'Unknown message type.',
  unknown_topic: 'Unknown topic.',
  not_subscribed: 'Not subscribed to that topic.',
  too_many_subscriptions: 'Too many subscriptions on this connection.',
  forbidden: 'You can only reach your own organization.',
  reseller_private_data_denied: 'Resellers cannot access private tenant data.',
  permission_denied: 'You do not have permission to do that.',
  unavailable: 'Live updates are unavailable right now. Try again shortly.',
};
