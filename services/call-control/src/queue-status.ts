import type { AuditEventInput } from '@cuc/audit';
import { ProblemError } from '@cuc/http';
import type { Logger } from '@cuc/logger';

import {
  UpstreamError,
  type ExtensionScope,
  type ExtensionScopeLookup,
  type TenantDomainLookup,
} from './clients.js';
import type { EslApiResult } from './esl/client.js';

/** The part of an ESL client this needs. */
export interface QueueEsl {
  sendApi(command: string): Promise<EslApiResult>;
}

/** An agent's availability, as the console and its API name it. */
export type AgentStatus = 'available' | 'on_break' | 'logged_out';

/** `mod_callcenter`'s own names for them. */
const CALLCENTER_STATUS: Readonly<Record<AgentStatus, string>> = {
  available: 'Available',
  on_break: 'On Break',
  logged_out: 'Logged Out',
};

function statusOf(callcenter: string): AgentStatus | 'other' {
  switch (callcenter) {
    case 'Available':
    case 'Available (On Demand)':
      return 'available';
    case 'On Break':
      return 'on_break';
    case 'Logged Out':
      return 'logged_out';
    default:
      return 'other';
  }
}

/** What an agent is doing, in the console's words (`mod_callcenter`'s agent state). */
export type AgentActivity = 'waiting' | 'ringing' | 'on_call' | 'idle';

function activityOf(state: string): AgentActivity {
  switch (state) {
    case 'Waiting':
      return 'waiting';
    case 'Receiving':
      return 'ringing';
    case 'In a queue call':
      return 'on_call';
    default:
      return 'idle';
  }
}

export interface LiveQueueAgent {
  /** The agent's extension number. */
  readonly extension: string;
  readonly status: AgentStatus | 'other';
  readonly activity: AgentActivity;
  readonly callsAnswered: number;
  /** When the status last changed (ISO), when the node says. */
  readonly statusSince: string | null;
}

/**
 * One queue as it is now: counts and statuses only, never a caller's number (the `queues` topic
 * is `config`-class; a caller's details belong on `calls`).
 */
export interface LiveQueue {
  readonly queueId: string;
  /** Callers waiting to be answered. */
  readonly waiting: number;
  /** When the longest-waiting caller joined (ISO); null when nobody waits. */
  readonly longestWaitingSince: string | null;
  /** Callers talking to an agent. */
  readonly answered: number;
  readonly callsAnswered: number;
  readonly callsAbandoned: number;
  readonly agents: LiveQueueAgent[];
}

export interface QueueStatusOptions {
  /** The nodes in service. */
  readonly liveNodeIds: () => Promise<string[]>;
  readonly esl: (nodeId: string) => QueueEsl | undefined;
  readonly tenantDomain: TenantDomainLookup;
  readonly extensionScope: ExtensionScopeLookup;
  /** Writes the audit event to the outbox; resolves once it is committed. */
  readonly audit: (input: AuditEventInput) => Promise<void>;
  /** OpenSIPs' SIP address as the nodes reach it, for the agent's contact (`agent_status.lua`). */
  readonly opensipsSipUri: string;
  readonly logger: Logger;
}

export interface AgentStatusCommand {
  readonly tenantId: string;
  /** The agent's extension number. */
  readonly extension: string;
  readonly status: AgentStatus;
  readonly actor: { readonly id: string; readonly orgId: string };
  /** Self-service: the person's own extension. */
  readonly own: boolean;
  /**
   * S9-20: decides, from the queues the agent answers, whether the person may change their status
   * (`queue.agent.manage` on one of them); throws to refuse. Runs before anything is audited.
   */
  readonly authorize?: (queueIds: readonly string[]) => Promise<void>;
  readonly ip?: string;
  readonly requestId?: string;
}

/** One of an agent's own queues as their home shows it (S9-20): its name, and who waits. */
export interface MyQueue {
  readonly queueId: string;
  /** Empty when pbx-config-service did not name it. */
  readonly label: string;
  readonly waiting: number;
  readonly longestWaitingSince: string | null;
}

export interface AgentView {
  readonly extension: string;
  /** Unknown until the agent has signed in or out on a node since it started. */
  readonly status: AgentStatus | 'other' | null;
  /** The queues the extension answers. */
  readonly queueIds: string[];
}

export interface QueueStatus {
  /** Every queue of the tenant a node has loaded (one that has had a call), as it is now. */
  live(tenantId: string): Promise<LiveQueue[]>;
  agent(tenantId: string, extension: string): Promise<AgentView>;
  /** The queues an extension answers, with how many wait in each; empty for no agent (S9-20). */
  mine(tenantId: string, extension: string): Promise<MyQueue[]>;
  setAgentStatus(command: AgentStatusCommand): Promise<AgentView>;
}

const EXTENSION_NUMBER = /^[0-9]{2,6}$/;
const SIP_DOMAIN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const QUEUE_ID = /^[0-9A-Za-z][0-9A-Za-z-]{0,63}$/;

/**
 * The rows of a `callcenter_config ... list` answer: a `|`-separated header line, a line per row,
 * and `+OK` at the end. Empty when the answer is anything else.
 */
export function parseCallcenterList(body: string): Record<string, string>[] {
  const lines = body
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '');
  const header = lines[0];
  if (header === undefined || !header.includes('|') || header.startsWith('-ERR')) return [];
  const names = header.split('|');
  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith('+OK') || line.startsWith('-ERR')) break;
    const values = line.split('|');
    rows.push(Object.fromEntries(names.map((name, index) => [name, values[index] ?? ''])));
  }
  return rows;
}

function epochIso(value: string | undefined): string | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

function count(value: string | undefined): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

/**
 * S9-13: the tenant's queues as `mod_callcenter` has them now, and signing an agent in, out and
 * on a break from the console, for the attendant console, the monitoring page and wallboards
 * (S7-06).
 *
 * `mod_callcenter` keeps queues and agents in each node's memory, so this asks every node in
 * service (`callcenter_config queue list`, then each of the tenant's queues' members and agents)
 * and merges what they say. An agent's status is set on every node the same way the `*45`/`*46`
 * feature codes set it on theirs (`agent_status.lua`: add, contact through OpenSIPs, status), so a
 * queue call reaches the agent whichever node holds the queue.
 */
export function createQueueStatus(options: QueueStatusOptions): QueueStatus {
  const { logger } = options;

  async function domainOf(tenantId: string): Promise<string> {
    let domain: string | undefined;
    try {
      domain = await options.tenantDomain(tenantId);
    } catch (error) {
      if (error instanceof UpstreamError) {
        throw ProblemError.unavailable('Queues could not be read right now. Try again shortly.', {
          code: 'queue_status_unavailable',
        });
      }
      throw error;
    }
    if (domain === undefined || !SIP_DOMAIN.test(domain)) {
      throw ProblemError.unavailable('Queues could not be read right now. Try again shortly.', {
        code: 'queue_status_unavailable',
      });
    }
    return domain;
  }

  /** Each node in service that this service can talk to. */
  async function nodes(): Promise<{ id: string; esl: QueueEsl }[]> {
    const found: { id: string; esl: QueueEsl }[] = [];
    for (const id of await options.liveNodeIds()) {
      const esl = options.esl(id);
      if (esl !== undefined) found.push({ id, esl });
    }
    return found;
  }

  async function list(esl: QueueEsl, command: string): Promise<Record<string, string>[]> {
    const result = await esl.sendApi(command);
    return result.ok ? parseCallcenterList(result.body) : [];
  }

  async function agentsOn(
    esl: QueueEsl,
    domain: string,
  ): Promise<Map<string, Record<string, string>>> {
    const agents = new Map<string, Record<string, string>>();
    for (const row of await list(esl, 'callcenter_config agent list')) {
      const name = row['name'] ?? '';
      if (!name.endsWith(`@${domain}`)) continue;
      const extension = name.slice(0, -domain.length - 1);
      if (EXTENSION_NUMBER.test(extension)) agents.set(extension, row);
    }
    return agents;
  }

  /** The agent's status where it changed last, across the nodes. */
  function latest(rows: Record<string, string>[]): Record<string, string> | undefined {
    return rows.reduce<Record<string, string> | undefined>(
      (best, row) =>
        best === undefined || count(row['last_status_change']) > count(best['last_status_change'])
          ? row
          : best,
      undefined,
    );
  }

  async function agentQueues(tenantId: string, extension: string): Promise<string[] | undefined> {
    const scope = await scopeOf(tenantId, extension);
    return scope === undefined ? undefined : [...scope.agentQueueIds];
  }

  async function scopeOf(tenantId: string, extension: string): Promise<ExtensionScope | undefined> {
    try {
      return await options.extensionScope(tenantId, extension);
    } catch (error) {
      if (error instanceof UpstreamError) {
        throw ProblemError.unavailable('Queues could not be read right now. Try again shortly.', {
          code: 'queue_status_unavailable',
        });
      }
      throw error;
    }
  }

  async function agent(tenantId: string, extension: string): Promise<AgentView> {
    if (!EXTENSION_NUMBER.test(extension)) {
      throw ProblemError.notFound('That extension answers no queue.', { code: 'not_an_agent' });
    }
    const queueIds = await agentQueues(tenantId, extension);
    if (queueIds === undefined || queueIds.length === 0) {
      throw ProblemError.notFound('That extension answers no queue.', { code: 'not_an_agent' });
    }
    const domain = await domainOf(tenantId);
    const rows: Record<string, string>[] = [];
    for (const node of await nodes()) {
      const row = (await agentsOn(node.esl, domain)).get(extension);
      if (row !== undefined) rows.push(row);
    }
    const found = latest(rows);
    return {
      extension,
      status: found === undefined ? null : statusOf(found['status'] ?? ''),
      queueIds,
    };
  }

  const queueStatus: QueueStatus = {
    async live(tenantId) {
      const domain = await domainOf(tenantId);
      const queues = new Map<
        string,
        {
          waiting: number;
          longest: number | undefined;
          answered: number;
          callsAnswered: number;
          callsAbandoned: number;
          agents: Map<string, Record<string, string>[]>;
        }
      >();
      for (const node of await nodes()) {
        for (const row of await list(node.esl, 'callcenter_config queue list')) {
          const name = row['name'] ?? '';
          if (!name.endsWith(`@${domain}`)) continue;
          const queueId = name.slice(0, -domain.length - 1);
          if (!QUEUE_ID.test(queueId)) continue;
          let queue = queues.get(queueId);
          if (queue === undefined) {
            queue = {
              waiting: 0,
              longest: undefined,
              answered: 0,
              callsAnswered: 0,
              callsAbandoned: 0,
              agents: new Map(),
            };
            queues.set(queueId, queue);
          }
          queue.callsAnswered += count(row['calls_answered']);
          queue.callsAbandoned += count(row['calls_abandoned']);
          for (const member of await list(
            node.esl,
            `callcenter_config queue list members ${name}`,
          )) {
            const state = member['state'] ?? '';
            if (state === 'Waiting' || state === 'Trying') {
              queue.waiting += 1;
              const joined = count(member['joined_epoch']);
              if (joined > 0 && (queue.longest === undefined || joined < queue.longest)) {
                queue.longest = joined;
              }
            } else if (state === 'Answered') {
              queue.answered += 1;
            }
          }
          // The queue's agents (by its tiers), with their status on this node.
          for (const row of await list(node.esl, `callcenter_config queue list agents ${name}`)) {
            const agentName = row['name'] ?? '';
            if (!agentName.endsWith(`@${domain}`)) continue;
            const extension = agentName.slice(0, -domain.length - 1);
            if (!EXTENSION_NUMBER.test(extension)) continue;
            const rows = queue.agents.get(extension) ?? [];
            rows.push(row);
            queue.agents.set(extension, rows);
          }
        }
      }
      return [...queues.entries()]
        .map(([queueId, queue]) => ({
          queueId,
          waiting: queue.waiting,
          longestWaitingSince:
            queue.longest === undefined ? null : new Date(queue.longest * 1000).toISOString(),
          answered: queue.answered,
          callsAnswered: queue.callsAnswered,
          callsAbandoned: queue.callsAbandoned,
          agents: [...queue.agents.entries()]
            .map(([extension, rows]) => {
              const row = latest(rows)!;
              return {
                extension,
                status: statusOf(row['status'] ?? ''),
                activity: activityOf(row['state'] ?? ''),
                callsAnswered: count(row['calls_answered']),
                statusSince: epochIso(row['last_status_change']),
              };
            })
            .sort((a, b) => a.extension.localeCompare(b.extension)),
        }))
        .sort((a, b) => a.queueId.localeCompare(b.queueId));
    },

    agent,

    async mine(tenantId, extension) {
      if (!EXTENSION_NUMBER.test(extension)) return [];
      const scope = await scopeOf(tenantId, extension);
      if (scope === undefined || scope.agentQueueIds.length === 0) return [];
      const labels = new Map((scope.agentQueues ?? []).map((queue) => [queue.id, queue.label]));
      // A queue no node has loaded yet (G-47) has had no call, so nobody waits in it.
      const live = new Map(
        (await queueStatus.live(tenantId)).map((queue) => [queue.queueId, queue]),
      );
      return scope.agentQueueIds
        .map((queueId) => ({
          queueId,
          label: labels.get(queueId) ?? '',
          waiting: live.get(queueId)?.waiting ?? 0,
          longestWaitingSince: live.get(queueId)?.longestWaitingSince ?? null,
        }))
        .sort((a, b) => a.label.localeCompare(b.label) || a.queueId.localeCompare(b.queueId));
    },

    async setAgentStatus(command) {
      const { tenantId, extension, status } = command;
      if (!EXTENSION_NUMBER.test(extension)) {
        throw ProblemError.notFound('That extension answers no queue.', { code: 'not_an_agent' });
      }
      const queueIds = await agentQueues(tenantId, extension);
      if (queueIds === undefined || queueIds.length === 0) {
        throw ProblemError.notFound('That extension answers no queue.', { code: 'not_an_agent' });
      }
      await command.authorize?.(queueIds);
      const domain = await domainOf(tenantId);
      const targets = await nodes();
      if (targets.length === 0) {
        throw ProblemError.unavailable(
          'Queues could not be reached right now. Try again shortly.',
          {
            code: 'media_unavailable',
          },
        );
      }
      try {
        await options.audit({
          actorType: 'user',
          actorId: command.actor.id,
          actorOrgId: command.actor.orgId,
          targetOrgId: tenantId,
          action: 'queue.agent.status_changed',
          resource: `extension:${extension}`,
          dataClass: 'config',
          reason: command.own ? `${status} (self-service)` : status,
          ...(command.ip === undefined ? {} : { ip: command.ip }),
          ...(command.requestId === undefined ? {} : { requestId: command.requestId }),
        });
      } catch (error) {
        logger.error(
          { err: error, tenantId },
          'queue status: the audit event could not be written',
        );
        throw ProblemError.unavailable(
          'Queues could not be reached right now. Try again shortly.',
          {
            code: 'queue_status_unavailable',
          },
        );
      }
      const name = `${extension}@${domain}`;
      const contact = `{sip_route_uri=sip:${options.opensipsSipUri}}sofia/internal/${name}`;
      let done = 0;
      for (const node of targets) {
        try {
          // As `agent_status.lua` does: `add` is harmless for a loaded agent, and makes sure one
          // added after the node started exists before its status is set.
          await node.esl.sendApi(`callcenter_config agent add '${name}' 'callback'`);
          await node.esl.sendApi(`callcenter_config agent set contact '${name}' '${contact}'`);
          const set = await node.esl.sendApi(
            `callcenter_config agent set status '${name}' '${CALLCENTER_STATUS[status]}'`,
          );
          if (set.ok && !set.body.startsWith('-ERR')) done += 1;
          else logger.warn({ nodeId: node.id, body: set.body }, 'queue status: node refused');
        } catch (error) {
          logger.warn({ err: error, nodeId: node.id }, 'queue status: node unreachable');
        }
      }
      if (done === 0) {
        throw ProblemError.unavailable('The media nodes did not carry that out. Try again.', {
          code: 'media_node_failed',
        });
      }
      return { extension, status, queueIds };
    },
  };
  return queueStatus;
}
