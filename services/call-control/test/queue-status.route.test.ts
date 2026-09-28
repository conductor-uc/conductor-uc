import type { AuditEventInput } from '@cuc/audit';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';
import { silentLogger } from '@cuc/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { EslApiResult } from '../src/esl/client.js';
import { createQueueStatus, parseCallcenterList, type QueueEsl } from '../src/queue-status.js';
import {
  registerQueueStatusInternalRoutes,
  registerQueueStatusRoutes,
} from '../src/routes/queue-status.routes.js';

const SECRET = 'test-internal-header-secret';
const TOKEN = 'internal-token';
const TENANT = 'tenant-1';
const DOMAIN = 'acme.platform.test';
const OTHER = 'other.platform.test';

const AGENT_HEADER =
  'name|instance_id|uuid|type|contact|status|state|max_no_answer|wrap_up_time|reject_delay_time|busy_delay_time|no_answer_delay_time|last_bridge_start|last_bridge_end|last_offered_call|last_status_change|no_answer_count|calls_answered|talk_time|ready_time|external_calls_count';
const agentRow = (name: string, status: string, state: string, changed: number, answered = 0) =>
  `${name}|single_box|x|callback|c|${status}|${state}|3|10|10|60|0|0|0|0|${String(changed)}|0|${String(answered)}|0|0|0`;

/** A media node's `mod_callcenter`: its queues, their members, and its agents. */
class FakeCallcenter implements QueueEsl {
  readonly commands: string[] = [];
  readonly queues = new Map<string, { members: string[]; agents: string[] }>();
  agents: string[] = [];

  sendApi(command: string): Promise<EslApiResult> {
    this.commands.push(command);
    const ok = (body: string) => Promise.resolve({ ok: true, body });
    if (command === 'callcenter_config queue list') {
      const header =
        'name|strategy|moh_sound|time_base_score|tier_rules_apply|tier_rule_wait_second|tier_rule_no_agent_no_wait|discard_abandoned_after|abandoned_resume_allowed|tier_rule_wait_multiply_level|record_template|calls_answered|calls_abandoned|ring_progressively_delay';
      return ok(
        [
          header,
          ...[...this.queues.keys()].map(
            (name) =>
              `${name}|ring-all|local_stream://moh|system|false|300|true|60|false|true||4|1|10`,
          ),
          '+OK',
        ].join('\n'),
      );
    }
    const members = /^callcenter_config queue list members (\S+)$/.exec(command);
    if (members !== null) {
      const header =
        'queue|instance_id|uuid|session_uuid|cid_number|cid_name|system_epoch|joined_epoch|rejoined_epoch|bridge_epoch|abandoned_epoch|base_score|skill_score|serving_agent|serving_system|state|score';
      return ok([header, ...(this.queues.get(members[1]!)?.members ?? []), '+OK'].join('\n'));
    }
    const agents = /^callcenter_config queue list agents (\S+)$/.exec(command);
    if (agents !== null) {
      return ok([AGENT_HEADER, ...(this.queues.get(agents[1]!)?.agents ?? []), '+OK'].join('\n'));
    }
    if (command === 'callcenter_config agent list') {
      return ok([AGENT_HEADER, ...this.agents, '+OK'].join('\n'));
    }
    return ok('+OK');
  }
}

const member = (name: string, joined: number, state: string) =>
  `${name}|single_box|m|s|+15550100|Caller|0|${String(joined)}|0|0|0|0|0|||${state}|0`;

describe('live queues and agents’ status (S9-13)', () => {
  let app: Server;
  const nodes = new Map<string, FakeCallcenter>();
  const audits: AuditEventInput[] = [];
  const held = new Map<string, string[]>();
  /** Extension number to the queues it answers. */
  const agentsOf = new Map<string, string[]>();
  const numbers = new Map<string, string>();

  beforeAll(async () => {
    app = await createServer({
      serviceName: 'call-control-test',
      logger: silentLogger(),
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
      permissions: (actor, permission) =>
        Promise.resolve(held.get(actor.id)?.includes(permission) ?? false),
    });
    const status = createQueueStatus({
      liveNodeIds: () => Promise.resolve([...nodes.keys()]),
      esl: (nodeId) => nodes.get(nodeId),
      tenantDomain: () => Promise.resolve(DOMAIN),
      extensionScope: (_tenantId, number) => {
        const queues = agentsOf.get(number);
        return Promise.resolve(
          queues === undefined
            ? undefined
            : { extensionId: `EXT-${number}`, number, agentQueueIds: queues },
        );
      },
      audit: (input) => {
        audits.push(input);
        return Promise.resolve();
      },
      opensipsSipUri: 'opensips:5060',
      logger: silentLogger(),
    });
    registerQueueStatusRoutes(app, {
      status,
      userExtension: (_tenantId, userId) => {
        const number = numbers.get(userId);
        return Promise.resolve(
          number === undefined ? undefined : { extensionId: `EXT-${number}`, number },
        );
      },
    });
    registerQueueStatusInternalRoutes(app, { status, internalServiceToken: TOKEN });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => {
    nodes.clear();
    audits.length = 0;
    held.clear();
    agentsOf.clear();
    numbers.clear();
  });

  function person(permissions: string[], number?: string) {
    const userId = crypto.randomUUID();
    held.set(userId, permissions);
    if (number !== undefined) numbers.set(userId, number);
    return signInternalHeaders(SECRET, {
      actorId: userId,
      actorType: 'user',
      orgId: TENANT,
      orgType: 'tenant',
      tenantId: TENANT,
    });
  }

  it('reads a callcenter list answer', () => {
    expect(parseCallcenterList('a|b\n1|2\n3|4\n+OK\n')).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
    expect(parseCallcenterList('-ERR no such queue\n')).toEqual([]);
    expect(parseCallcenterList('')).toEqual([]);
  });

  it('gives the tenant’s queues across the nodes, as counts and statuses, never a caller’s number', async () => {
    const one = new FakeCallcenter();
    one.queues.set(`q1@${DOMAIN}`, {
      members: [
        member(`q1@${DOMAIN}`, 1_790_000_100, 'Waiting'),
        member(`q1@${DOMAIN}`, 1_790_000_050, 'Trying'),
        member(`q1@${DOMAIN}`, 1_790_000_000, 'Answered'),
      ],
      agents: [
        agentRow(`301@${DOMAIN}`, 'Available', 'In a queue call', 1_790_000_000, 3),
        agentRow(`302@${DOMAIN}`, 'On Break', 'Idle', 1_790_000_010),
      ],
    });
    // Another tenant's queue on the same node is not this tenant's business.
    one.queues.set(`q9@${OTHER}`, { members: [member(`q9@${OTHER}`, 1, 'Waiting')], agents: [] });
    const two = new FakeCallcenter();
    // 302 signed back in on the other node later: the latest change wins.
    two.queues.set(`q1@${DOMAIN}`, {
      members: [],
      agents: [agentRow(`302@${DOMAIN}`, 'Available', 'Waiting', 1_790_000_500)],
    });
    nodes.set('fs-1', one);
    nodes.set('fs-2', two);

    const response = await app.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${TENANT}/queues`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      queues: [
        {
          queueId: 'q1',
          waiting: 2,
          longestWaitingSince: new Date(1_790_000_050_000).toISOString(),
          answered: 1,
          callsAnswered: 8,
          callsAbandoned: 2,
          agents: [
            {
              extension: '301',
              status: 'available',
              activity: 'on_call',
              callsAnswered: 3,
              statusSince: new Date(1_790_000_000_000).toISOString(),
            },
            {
              extension: '302',
              status: 'available',
              activity: 'waiting',
              callsAnswered: 0,
              statusSince: new Date(1_790_000_500_000).toISOString(),
            },
          ],
        },
      ],
    });
    expect(response.body).not.toContain('+15550100');

    const refused = await app.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${TENANT}/queues`,
      headers: { authorization: 'Bearer wrong' },
    });
    expect(refused.statusCode).toBe(401);
  });

  it('a person signs in as an agent on every node, as the feature code does, and it is audited', async () => {
    const one = new FakeCallcenter();
    const two = new FakeCallcenter();
    nodes.set('fs-1', one);
    nodes.set('fs-2', two);
    agentsOf.set('301', ['q1']);
    const headers = person(['self.settings'], '301');

    const response = await app.inject({
      method: 'PUT',
      url: `/v1/tenants/${TENANT}/me/agent-status`,
      headers,
      payload: { status: 'on_break' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ extension: '301', status: 'on_break', queueIds: ['q1'] });
    for (const node of [one, two]) {
      expect(node.commands).toEqual([
        `callcenter_config agent add '301@${DOMAIN}' 'callback'`,
        `callcenter_config agent set contact '301@${DOMAIN}' '{sip_route_uri=sip:opensips:5060}sofia/internal/301@${DOMAIN}'`,
        `callcenter_config agent set status '301@${DOMAIN}' 'On Break'`,
      ]);
    }
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'queue.agent.status_changed',
        resource: 'extension:301',
        reason: 'on_break (self-service)',
      }),
    ]);
  });

  it('reads a person’s own status, and someone who answers no queue is not an agent', async () => {
    const one = new FakeCallcenter();
    one.agents = [agentRow(`301@${DOMAIN}`, 'Logged Out', 'Idle', 5)];
    nodes.set('fs-1', one);
    agentsOf.set('301', ['q1', 'q2']);
    const mine = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${TENANT}/me/agent-status`,
      headers: person(['self.settings'], '301'),
    });
    expect(mine.json()).toEqual({ extension: '301', status: 'logged_out', queueIds: ['q1', 'q2'] });

    const notAgent = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${TENANT}/me/agent-status`,
      headers: person(['self.settings'], '205'),
    });
    expect(notAgent.statusCode).toBe(404);
    expect(notAgent.json()).toMatchObject({ code: 'not_an_agent' });

    const unlinked = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${TENANT}/me/agent-status`,
      headers: person(['self.settings']),
    });
    expect(unlinked.json()).toMatchObject({ code: 'no_linked_extension' });
  });

  it('a supervisor signs an agent out; without call.control nobody else may', async () => {
    const one = new FakeCallcenter();
    nodes.set('fs-1', one);
    agentsOf.set('301', ['q1']);
    const done = await app.inject({
      method: 'PUT',
      url: `/v1/tenants/${TENANT}/live-agents/301/status`,
      headers: person(['call.control']),
      payload: { status: 'logged_out' },
    });
    expect(done.statusCode).toBe(200);
    expect(one.commands.at(-1)).toBe(
      `callcenter_config agent set status '301@${DOMAIN}' 'Logged Out'`,
    );
    expect(audits[0]).toMatchObject({ reason: 'logged_out' });

    const refused = await app.inject({
      method: 'PUT',
      url: `/v1/tenants/${TENANT}/live-agents/301/status`,
      headers: person(['self.settings'], '301'),
      payload: { status: 'logged_out' },
    });
    expect(refused.statusCode).toBe(403);

    const bad = await app.inject({
      method: 'PUT',
      url: `/v1/tenants/${TENANT}/live-agents/301/status`,
      headers: person(['call.control']),
      payload: { status: 'busy' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('with no node to reach, nothing is audited or done', async () => {
    agentsOf.set('301', ['q1']);
    const response = await app.inject({
      method: 'PUT',
      url: `/v1/tenants/${TENANT}/me/agent-status`,
      headers: person(['self.settings'], '301'),
      payload: { status: 'available' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'media_unavailable' });
    expect(audits).toEqual([]);
  });
});
