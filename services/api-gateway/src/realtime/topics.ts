import type { DataClass } from '@cuc/authz';

/**
 * The realtime topics (08 §5). Each one is `tenant:{tenantId}:{kind}` and, like
 * an HTTP route (CLAUDE.md rule 3), declares the permission a subscriber needs
 * and the data class of what it carries. The hub checks both on subscribe and
 * again periodically, with the same rules as `@cuc/http`'s permission guard:
 * the tenant boundary and org ancestry, H1, then the permission.
 *
 * - `calls` is live call monitoring, `private` in 07 §3.2: the parties'
 *   numbers, state, and recording state. `monitor.calls` (docs/decisions.md
 *   G-119). No reseller ever receives it (H1).
 * - `presence` is `monitor.presence` (config): which extensions are ringing or
 *   on a call, and nothing about the other party.
 * - `queues` is `queue.read` (config): live queue and agent state, as counts
 *   and statuses, never a caller's number. Per-call queue detail belongs on
 *   `calls`. Nothing publishes to it yet (see `feed.ts`); the topic exists so
 *   wallboards (S7-06) plug in without a protocol change.
 */
export const TOPIC_KINDS = ['calls', 'presence', 'queues'] as const;
export type TopicKind = (typeof TOPIC_KINDS)[number];

export interface TopicDefinition {
  readonly permission: string;
  readonly dataClass: DataClass;
}

export const TOPICS: Readonly<Record<TopicKind, TopicDefinition>> = {
  calls: { permission: 'monitor.calls', dataClass: 'private' },
  presence: { permission: 'monitor.presence', dataClass: 'config' },
  queues: { permission: 'queue.read', dataClass: 'config' },
};

export interface Topic {
  /** The canonical string, as clients send it. */
  readonly name: string;
  readonly tenantId: string;
  readonly kind: TopicKind;
}

/** Org ids are UUIDs; anything else is refused before it reaches a URL or a lookup. */
const TOPIC_PATTERN = /^tenant:([A-Za-z0-9][A-Za-z0-9-]{0,63}):([a-z]+)$/;

export function parseTopic(name: string): Topic | undefined {
  const match = TOPIC_PATTERN.exec(name);
  if (match === null) return undefined;
  const [, tenantId, kind] = match as unknown as [string, string, string];
  if (!(TOPIC_KINDS as readonly string[]).includes(kind)) return undefined;
  return { name, tenantId, kind: kind as TopicKind };
}

export function topicName(tenantId: string, kind: TopicKind): string {
  return `tenant:${tenantId}:${kind}`;
}
